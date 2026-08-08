// patch-israeli-bank-scrapers.mjs
//
// israeli-bank-scrapers deliberately excludes pending Isracard/Amex
// transactions -- ones that haven't been assigned a real voucher number
// yet (they come back with a placeholder of '000000000') -- from what it
// returns. That's a private filter inside the library with no setting to
// turn off, so the only way to get pending transactions at all is to
// patch the installed package's compiled code directly.
//
// Verified against the actual installed package (v6.9.0) at:
//   node_modules/israeli-bank-scrapers/lib/scrapers/base-isracard-amex.js
//
// npm wipes any manual edit to node_modules on every fresh `npm install`,
// so this script re-applies the patch every time -- it's run as its own
// step in the GitHub Actions workflow, right after "Install Moneyman's
// dependencies".
//
// SAFETY: this only removes the two voucher-number checks. It leaves the
// unrelated `dealSumType !== '1'` check untouched, since we don't know
// what that filters out and don't want to accidentally pull that in too.
//
// If a future version of israeli-bank-scrapers changes this code (renames
// fields, restructures the filter), this patch will stop matching and
// will print a warning instead of silently failing or breaking the
// workflow -- pending transactions would just stop coming through again
// until this script is updated to match the new code.
 
import { readFileSync, writeFileSync } from "fs";
 
const TARGET_FILE =
  "node_modules/israeli-bank-scrapers/lib/scrapers/base-isracard-amex.js";
 
const ORIGINAL =
  "const filteredTxns = txns.filter(txn => txn.dealSumType !== '1' && txn.voucherNumberRatz !== '000000000' && txn.voucherNumberRatzOutbound !== '000000000');";
const PATCHED = "const filteredTxns = txns.filter(txn => txn.dealSumType !== '1');";
 
let content;
try {
  content = readFileSync(TARGET_FILE, "utf-8");
} catch (err) {
  console.error(`WARNING: could not read ${TARGET_FILE} (${err.message}).`);
  console.error(
    "Skipping the pending-transactions patch this run -- pending transactions will not be included."
  );
  process.exit(0); // don't fail the whole workflow over this
}
 
if (content.includes(PATCHED) && !content.includes(ORIGINAL)) {
  console.log("Already patched — pending transactions will be included.");
  process.exit(0);
}
 
if (!content.includes(ORIGINAL)) {
  console.error(
    `WARNING: could not find the expected code to patch in ${TARGET_FILE}. ` +
      "israeli-bank-scrapers may have been updated and changed this internally. " +
      "Pending transactions will NOT be included this run — this needs a manual look " +
      "(check base-isracard-amex.js for how it filters transactions now)."
  );
  process.exit(0); // don't fail the whole workflow over this
}
 
writeFileSync(TARGET_FILE, content.replace(ORIGINAL, PATCHED), "utf-8");
console.log("Patched israeli-bank-scrapers — pending transactions will now be included.");
