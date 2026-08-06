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

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { createClient } from "@base44/sdk";

const OUTPUT_DIR = path.join(process.cwd(), "output");

function toIsoDate(value) {
  // Moneyman sends dates as "dd/mm/yyyy"; Base44's date field expects "yyyy-mm-dd".
  if (!value) return "";
  const parts = String(value).split("/");
  if (parts.length !== 3) return value; // already ISO-shaped, or unrecognized — pass through
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
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

  if (transactions.length === 0) {
    console.log("Nothing to push. Exiting.");
    return;
  }

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

  // Map Moneyman's transaction shape onto your real Transaction entity fields.
  const records = transactions.map((t) => {
    const noteParts = [t.memo, t.comment].filter(Boolean);
    if (t.account) noteParts.push(`Account: ${t.account}`);

    return {
      transaction_date: toIsoDate(t.date),
      merchant: t.description ?? "",
      amount: t.amount ?? t.chargedAmount ?? 0,
      notes: noteParts.join(" | "),
      source: "import",
      external_transaction_id: String(t.hash ?? t.identifier ?? ""),
    };
  });

  // Skip anything that's already in Base44 (see DUPLICATE PROTECTION note
  // at the top of this file). We match on date + merchant + amount rather
  // than external_transaction_id alone, since some scrapers reuse the same
  // reference number across genuinely different transactions.
  console.log("Checking Base44 for transactions that already exist...");
  const existing = await base44.entities.Transaction.list();
  const existingSignatures = new Set(
    existing.map((r) => `${r.transaction_date}|${r.merchant}|${r.amount}`)
  );

  const newRecords = records.filter(
    (r) => !existingSignatures.has(`${r.transaction_date}|${r.merchant}|${r.amount}`)
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
