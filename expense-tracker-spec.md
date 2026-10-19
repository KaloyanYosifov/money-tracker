# Personal Expense Tracker — Product Specification

## Product goal

Build a simple personal finance app for quickly recording income and expenses, seeing where money goes, and making practical plans for spending and saving.

The experience should feel approachable and low effort, using Spending Tracker as a reference for its simple transaction entry, flexible time periods, category summaries, budgets, and charts. This is a request for exact interface. The [Spending Tracker App Store listing](https://apps.apple.com/us/app/spending-tracker/id548615579) describes its current public features.

## Target platforms

- **iOS:** iPhone first; support iPad layouts.
- **Desktop:** desktop web app. Choose the approach that best supports shared code and a consistent experience across devices.
- Keep the core workflows and data consistent across platforms.

## Product principles

1. **Fast entry:** Recording a transaction should take only a few seconds.
2. **Works offline:** The app remains usable without a network connection.
3. **Clear by default:** Show useful summaries without requiring users to configure a detailed budget.
4. **User-owned data:** Users can export their data and choose where it syncs.
5. **Suggestions are explainable:** AI may help users interpret their spending, but should not make decisions or change data automatically.

## Core user stories

- As a user, I can quickly record an expense or income with an amount, date, and category.
- As a user, I can review my spending over a week, month, year, or custom date range.
- As a user, I can see spending totals by category and compare periods.
- As a user, I can enter my salary and recurring income, then plan how to allocate it.
- As a user, I can get optional suggestions for reducing expenses based on my own data.
- As a user, I can keep using the app offline and sync changes when my server is reachable.
- As a user of Spending Tracker, I can import its exported data and review it before adding it to the app.

## Functional requirements

### 1. Transactions

Support the following transaction types:

- Expense
- Income
- Transfer between accounts, if accounts are included in the initial release

Each transaction should support:

- Amount and currency
- Type
- Date
- Category
- Account, if accounts are enabled
- Optional merchant/payee
- Optional note
- Optional recurring schedule
- Created and modified timestamps for synchronization

Allow users to add, edit, delete, and search transactions. Provide date-range and category filters. Make expense and income entry visually distinct and keep the amount entry prominent.

### 2. Categories and accounts

- Provide sensible default income and expense categories.
- Let users create, rename, recolor, reorder, and archive categories.
- Preserve historical transactions when a category is archived or renamed.
- Decide whether multiple accounts are needed for the first release. If included, support at least cash and bank accounts, with transfers that do not count as income or expense.

### 3. Overview, charts, and reports

Provide a simple overview for a selected period containing:

- Total income
- Total expenses
- Net difference
- Budget progress, when a budget is configured
- Spending by category
- Spending history over time

Support weekly, monthly, yearly, and custom date ranges. Charts should be readable on a phone and offer an accessible textual summary. Users should be able to tap a chart or category to see the underlying transactions.

### 4. Budgets and salary planning

Budgeting should be optional. Users should be able to:

- Set an overall budget for a chosen period.
- Optionally set category budgets.
- See remaining budget and whether spending is above or below plan.
- Enter salary amount, currency, pay frequency, and next pay date.
- Add other recurring income.
- Create a suggested allocation across bills, everyday spending, savings, and discretionary spending.
- Adjust or ignore any suggested allocation.

Clearly distinguish forecasts and suggestions from recorded transactions. Do not treat a planned salary or budget allocation as money received or spent.

### 5. AI spending suggestions

Offer an opt-in feature that can analyze selected transaction history and provide suggestions such as:

- Categories where spending has risen.
- Recurring charges or subscriptions to review.
- Changes that could fit a user’s stated savings target.
- A suggested salary allocation based on recurring bills and past spending.

Requirements:

- Explain which data and date range a suggestion uses.
- Show the reasoning and estimated impact where possible.
- Let users dismiss suggestions and correct incorrect category or recurring-charge assumptions.
- Never modify transactions, contact a bank, or cancel a service on the user’s behalf.
- Keep AI optional and make clear that its output is guidance, not a guarantee.

The implementation agent should propose an architecture that works with the user’s home infrastructure and document what financial data is sent to any AI provider. Prefer a configurable provider or a self-hosted option if practical.

### 6. Local storage and synchronization

- Store all core data locally so transaction entry and review work without connectivity.
- Queue local changes while offline and sync them when the configured server is reachable.
- Show sync state clearly, including pending changes and the most recent successful sync.
- Use stable record IDs and a documented conflict-resolution strategy.
- Avoid duplicate transactions when syncing or retrying failed operations.
- Support backup and restore, and provide a way to export all user data.
- Document authentication, encryption in transit, server-side data protection, and recovery from device loss.

“Cloud sync” should be configurable to the user’s home server. The implementation agent should recommend a protocol and deployment approach suitable for a single household rather than assume a hosted vendor.

### 7. Import from Spending Tracker

The linked app advertises transaction export; its App Store listing mentions PDF and CSV export options. Use CSV as the primary import path unless representative exports indicate another format is needed.

- Let users select the export file using the platform’s file picker.
- Preview parsed transactions before import.
- Map source columns to fields and let users map source categories to app categories.
- Report rows that could not be parsed and allow users to skip or fix them.
- Detect likely duplicates and let the user review them.
- Preserve original dates, amounts, income/expense type, category, and notes where the export contains them.
- Do not claim compatibility with an undocumented native database or proprietary backup format.

The implementation agent should inspect representative exports before finalizing the parser and document any unsupported fields.

### 8. Banking connections (future capability)

Bank integration is a potential later feature, not a prerequisite for the first usable version.

Design the data model so imported bank transactions can be added later without replacing manual entry. Before implementing a connection, evaluate regional provider availability, cost, security, consent, and maintenance requirements. Imported transactions should be reviewable, deduplicated, and editable, with clear source attribution.

## Nonfunctional requirements

- Protect financial information with appropriate local-device security and encrypted network transport.
- Support device accessibility settings, including dynamic text sizing, VoiceOver, and sufficient contrast.
- Handle locale-specific dates, number formats, and currencies.
- Keep common screens responsive with a substantial transaction history.
- Provide data export in a documented, widely usable format such as CSV or JSON.
- Make deletion and backup behavior understandable to users.

## Suggested MVP scope

1. iOS app with local transaction storage.
2. Manual income and expense entry.
3. Editable categories.
4. Period overview and category/history charts.
5. Overall optional budget.
6. CSV import with preview and category mapping.
7. Export and backup.
8. Offline-first sync to a home-hosted service, if feasible in the initial architecture.

Salary planning and AI suggestions can follow once transaction tracking and sync are dependable. Bank connections should be evaluated separately.

## Decisions for the implementation agent

Return a proposed architecture and phased plan covering:

- Native iOS plus macOS, or cross-platform iOS plus desktop.
- Local database and sync protocol, including conflict handling.
- Home-server deployment, authentication, and backup strategy.
- CSV import format assumptions and how to validate them.
- AI provider options, data flow, opt-in controls, and estimated operating cost.
- Whether salary planning belongs in the MVP or a later phase.
- Banking integration options for the user’s region, if pursued.

## MVP acceptance criteria

- A user can add, edit, and delete income and expense transactions without an internet connection.
- The overview totals and charts reflect those transactions for selectable periods.
- The user can configure a budget and see progress against it.
- The user can import a Spending Tracker CSV, review the result, map categories, and avoid accidental duplicates.
- Pending changes sync after connectivity returns, without creating duplicates.
- The user can export their data and understand the current sync state.
- AI and banking features, if present, are opt-in and clearly distinguish suggestions or imported data from manually recorded transactions.
