/**
 * Mock Salesforce Server (port 3003)
 *
 * Simulates Salesforce REST API for Account object upserts.
 * Stores field values in memory and serves them to the demo UI.
 * Also serves the demo dashboard HTML at /
 */

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── In-Memory Salesforce "Database" ──────────────────────────────────────
const accounts = {
  "0015g00000XkYzAAA1": {
    Id: "0015g00000XkYzAAA1",
    Name: "Acme Corp",
    Industry: "Financial Services",
    AnnualRevenue: 4200000,
    Phone: "+1 (555) 010-1234",
    BillingCity: "San Francisco",
    BillingState: "CA",
    AccountOwner: "Sarah Chen",
    Type: "Customer",
    // Sardine custom fields (initially empty — populated by connector)
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
  "0015g00000XkYzAAA2": {
    Id: "0015g00000XkYzAAA2",
    Name: "Globex Financial",
    Industry: "Banking",
    AnnualRevenue: 18500000,
    Phone: "+1 (555) 020-5678",
    BillingCity: "New York",
    BillingState: "NY",
    AccountOwner: "Marcus Thompson",
    Type: "Customer",
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
  "0015g00000XkYzAAA3": {
    Id: "0015g00000XkYzAAA3",
    Name: "Initech Payments",
    Industry: "Fintech",
    AnnualRevenue: 2100000,
    Phone: "+1 (555) 030-9012",
    BillingCity: "Austin",
    BillingState: "TX",
    AccountOwner: "Priya Patel",
    Type: "Prospect",
    Sardine_Risk_Level__c: "—",
    Sardine_Fraud_Score__c: null,
    Sardine_KYC_Status__c: "—",
    Sardine_KYC_Level__c: "—",
    Sardine_AML_Risk__c: "—",
    Sardine_Device_Risk__c: "—",
    Sardine_Device_Signals__c: "—",
    Sardine_Behavior_Signals__c: "—",
    Sardine_Case_Status__c: "—",
    Sardine_Case_ID__c: "—",
    Sardine_Checkpoints_Passed__c: "—",
    Sardine_Checkpoints_Failed__c: "—",
    Sardine_Last_Updated__c: null,
    _updateHistory: [],
  },
};

// ─── Salesforce REST API (simulated) ──────────────────────────────────────

// PATCH /services/data/v58.0/sobjects/Account/:id — upsert fields
app.patch("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) {
    return res.status(404).json({ errorCode: "NOT_FOUND", message: "Account not found" });
  }

  const updatedFields = req.body;
  const prevRisk = account.Sardine_Risk_Level__c;

  // Apply field updates
  Object.assign(account, updatedFields);

  // Track history for the demo
  account._updateHistory.unshift({
    timestamp: new Date().toISOString(),
    prevRisk,
    newRisk: account.Sardine_Risk_Level__c,
    fraudScore: account.Sardine_Fraud_Score__c,
  });
  if (account._updateHistory.length > 10) account._updateHistory.pop();

  console.log(`[Salesforce] PATCH Account ${req.params.id} (${account.Name}) → Risk: ${account.Sardine_Risk_Level__c}, Score: ${account.Sardine_Fraud_Score__c}`);
  res.status(204).send();
});

// GET /services/data/v58.0/sobjects/Account/:id — fetch account
app.get("/services/data/v58.0/sobjects/Account/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ errorCode: "NOT_FOUND" });
  res.json(account);
});

// GET /api/accounts — all accounts for demo UI
app.get("/api/accounts", (req, res) => {
  res.json(Object.values(accounts));
});

// GET /api/accounts/:id — single account for demo UI
app.get("/api/accounts/:id", (req, res) => {
  const account = accounts[req.params.id];
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json(account);
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = 3003;
app.listen(PORT, () => {
  console.log(`[Salesforce] Mock API + UI running on http://localhost:${PORT}`);
});
