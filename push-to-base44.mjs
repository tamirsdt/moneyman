// push-to-base44.mjs
// Reads the newest transactions file Moneyman produced and pushes
// each transaction into your Base44 app's Transaction entity,
// using a dedicated Base44 account (not an admin key).

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { createClient } from "@base44/sdk";

const OUTPUT_DIR = path.join(process.cwd(), "output");

function toIsoDate(value) {
  if (!value) return "";
  const parts = String(value).split("/");
  if (parts.length !== 3) return value;
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function getLatestFile() {
  const files = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error("No output file found in ./output");
  }
  files.sort();
  return path.join(OUTPUT_DIR, files[files.length - 1]);
}

async function main() {
  const filePath = getLatestFile();
  console.log(`Reading transactions from: ${filePath}`);

  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  const transactions = Array.isArray(raw) ? raw : [];
  console.log(`Found ${transactions.length} transaction(s)`);

  if (transactions.length === 0) {
    console.log("Nothing to push. Exiting.");
    return;
  }

  const appId = process.env.BASE44_APP_ID;
  const email = process.env.BASE44_BOT_EMAIL;
  const password = process.env.BASE44_BOT_PASSWORD;

  if (!appId || !email || !password) {
    throw new Error("Missing BASE44_APP_ID, BASE44_BOT_EMAIL, or BASE44_BOT_PASSWORD");
  }

  const base44 = createClient({ appId });
  await base44.auth.loginViaEmailPassword(email, password);
  console.log("Logged into Base44 successfully.");

  const records = transactions.map((t) => {
    const noteParts = [t.memo, t.comment].filter(Boolean);
    if (t.account) noteParts.push(`Account: ${t.account}`);

    return {
      transaction_date: toIsoDate(t.date),
      merchant: t.description ?? "",
      amount: t.amount ?? t.chargedAmount ?? 0,
      notes: noteParts.join(" | "),
      source: "import",
      external_transaction_id: t.hash ?? t.identifier ?? "",
    };
  });

  const result = await base44.entities.Transaction.bulkCreate(records);
  console.log(`Pushed ${result.length} record(s) into Base44.`);
}

main().catch((err) => {
  console.error("Failed to push transactions to Base44:");
  console.error(err);
  process.exit(1);
});
