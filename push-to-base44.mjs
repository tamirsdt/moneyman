// push-to-base44.mjs
//
// Reads the newest transactions file that Moneyman just produced
// (options.storage.localJson) and pushes each transaction into your
// Base44 app's real "Transaction" entity, using a dedicated Base44 user
// account (not your own login, and not an admin/service-role key).
//
// This script needs three environment variables, provided as GitHub
// Actions secrets (never hard-code them here):
//   BASE44_APP_ID        - found in your Base44 editor URL
//   BASE44_BOT_EMAIL      - the email of the dedicated Base44 account
//   BASE44_BOT_PASSWORD   - that account's password
//
// Mapped to your actual Transaction schema:
//   transaction_date (date, required)
//   merchant          (text, required)
//   amount            (number, required)
//   notes             (text)
//   source            (text)  -> always set to "import" here
//   external_transaction_id (text) -> Moneyman's hash/identifier, for de-duping later.
//     Sent through String(...) because some scrapers (Hapoalim in particular)
//     return this as a plain number, which Base44 rejects with a 422 error.
//
// Left untouched (Base44's own defaults / your app's own logic fill these in):
//   type            -> defaults to "expense"
//   category_id     -> left blank so your CategorizationRule logic can fill it
//   payment_method  -> defaults to "card"
//   installments_total / installment_number -> default to 1
//
// KNOWN ASSUMPTION TO VERIFY: Moneyman doesn't tell us whether a transaction
// is an expense or income by name, only a signed amount. This script leaves
// "type" unset (so it defaults to "expense") rather than guessing from the
// sign, since card vs. bank-account sign conventions can differ. After your
// first real run, check a few rows and tell me if refunds/income need
// separating out — that's a one-line fix once we see real numbers.
//
// DUPLICATE PROTECTION: Moneyman's default lookback window (10 days) means
// most of what it scrapes on any given run was already pushed on a
// previous run. Before inserting anything, this script checks Base44 for
// transactions matching the same date + merchant + amount and skips those,
// so running this twice a day doesn't double your balance the way it did
// the first time this was wired up.
//
// ACCOUNT_TYPE: Isracard reports both the real credit card (7506) and the
// debit card (8100) through the same feed. We tell them apart by the
// account number embedded in t.account: 7506 -> credit_card, 8100 ->
// debit_card. Without this, new rows would land with account_type empty
// and silently disappear from all the Expenses tabs in the app.
//
// PENDING TRANSACTIONS: paired with patch-israeli-bank-scrapers.mjs, which
// stops the scraper from silently dropping transactions that haven't been
// assigned a real voucher number yet. Those come through with
// identifier === 0 (every pending transaction shares that same
// placeholder value), which is how we set is_pending. Pending rows are
// never matched against real ones for de-dup purposes -- the dedup
// signature includes is_pending, so a still-pending charge won't block
// its own finalized version from being inserted once it posts for real.
// Instead, any pending row gets deleted outright once it's more than 2
// days old, regardless of whether a matching real transaction has shown
// up yet -- see cleanupExpiredPending() below.
 
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { createClient } from "@base44/sdk";
 
const PENDING_MAX_AGE_DAYS = 2;
 
const OUTPUT_DIR = path.join(process.cwd(), "output");
 
function toIsoDate(value) {
  // Moneyman sends dates as "dd/mm/yyyy"; Base44's date field expects "yyyy-mm-dd".
  if (!value) return "";
  const parts = String(value).split("/");
  if (parts.length !== 3) return value; // already ISO-shaped, or unrecognized — pass through
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
 
async function cleanupExpiredPending(base44) {
  const existing = await base44.entities.Transaction.list();
  const cutoff = Date.now() - PENDING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
 
  const expired = existing.filter((r) => {
    if (!r.is_pending) return false;
    const created = new Date(r.created_date).getTime();
    return !Number.isNaN(created) && created < cutoff;
  });
 
  if (expired.length === 0) {
    console.log("No expired pending transactions to clean up.");
    return;
  }
 
  console.log(`Removing ${expired.length} pending transaction(s) older than ${PENDING_MAX_AGE_DAYS} day(s).`);
  for (const record of expired) {
    await base44.entities.Transaction.delete(record.id);
  }
}
 
function getLatestFile() {
  const files = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(
      "No output file found in ./output — did the scrape step run and find transactions first?"
    );
  }
  // Filenames are ISO timestamps, so sorting alphabetically = sorting by time
  files.sort();
  return path.join(OUTPUT_DIR, files[files.length - 1]);
}
 
async function main() {
  const filePath = getLatestFile();
  console.log(`Reading transactions from: ${filePath}`);
 
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const transactions = Array.isArray(raw) ? raw : [];
  console.log(`Found ${transactions.length} transaction(s) in the file`);
 
  const appId = process.env.BASE44_APP_ID;
  const email = process.env.BASE44_BOT_EMAIL;
  const password = process.env.BASE44_BOT_PASSWORD;
 
  if (!appId || !email || !password) {
    throw new Error(
      "Missing BASE44_APP_ID, BASE44_BOT_EMAIL, or BASE44_BOT_PASSWORD environment variables."
    );
  }
 
  const base44 = createClient({ appId });
  await base44.auth.loginViaEmailPassword(email, password);
  console.log("Logged into Base44 successfully.");
 
  // Clean up stale pending transactions first -- independent of whatever
  // is in this run's scrape (see PENDING TRANSACTIONS note at the top).
  // Runs even if there's nothing new to push below.
  await cleanupExpiredPending(base44);
 
  if (transactions.length === 0) {
    console.log("Nothing to push. Exiting.");
    process.exit(0);
  }
 
  // Map Moneyman's transaction shape onto your real Transaction entity fields.
  const records = transactions.map((t) => {
    const noteParts = [t.memo, t.comment].filter(Boolean);
    if (t.account) noteParts.push(`Account: ${t.account}`);
 
    const accountStr = String(t.account ?? "");
    let accountType = "bank_account"; // safe fallback, shouldn't normally hit this
    if (accountStr.includes("7506")) {
      accountType = "credit_card";
    } else if (accountStr.includes("8100")) {
      accountType = "debit_card";
    }
 
    // Every pending Isracard/Amex transaction shares the same placeholder
    // identifier (0), since it hasn't been assigned a real voucher number
    // yet. A genuine, finalized transaction never has identifier 0.
    const isPending = Number(t.identifier) === 0;
    if (isPending) {
      noteParts.push("Pending");
    }
 
    return {
      transaction_date: toIsoDate(t.date),
      merchant: t.description ?? "",
      amount: t.amount ?? t.chargedAmount ?? 0,
      notes: noteParts.join(" | "),
      source: "import",
      account_type: accountType,
      is_pending: isPending,
      external_transaction_id: String(t.hash ?? t.identifier ?? ""),
    };
  });
 
  // Skip anything that's already in Base44 (see DUPLICATE PROTECTION note
  // at the top of this file). We match on date + merchant + amount rather
  // than external_transaction_id alone, since some scrapers reuse the same
  // reference number across genuinely different transactions. is_pending
  // is part of the signature too -- a pending placeholder existing
  // shouldn't stop its real, finalized version from being inserted once
  // it posts, and vice versa a still-pending charge shouldn't get
  // re-inserted as a duplicate pending row on the next run.
  console.log("Checking Base44 for transactions that already exist...");
  const existing = await base44.entities.Transaction.list();
  const existingSignatures = new Set(
    existing.map((r) => `${r.transaction_date}|${r.merchant}|${r.amount}|${!!r.is_pending}`)
  );
 
  const newRecords = records.filter(
    (r) => !existingSignatures.has(`${r.transaction_date}|${r.merchant}|${r.amount}|${r.is_pending}`)
  );
  const skipped = records.length - newRecords.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} transaction(s) that are already in Base44.`);
  }
 
  if (newRecords.length === 0) {
    console.log("Nothing new to push. Exiting.");
    process.exit(0);
  }
 
  const result = await base44.entities.Transaction.bulkCreate(newRecords);
  console.log(`Pushed ${result.length} new record(s) into Base44's Transaction entity.`);
 
  // Force a clean exit -- the Base44 SDK keeps a keep-alive connection
  // open that otherwise stops the GitHub Actions job step from finishing.
  process.exit(0);
}
 
main().catch((err) => {
  console.error("Failed to push transactions to Base44:");
  console.error(err);
  process.exit(1);
});
