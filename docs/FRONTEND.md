# Using the web app

## Sign in

Sign in with Google through [shoo.dev](https://shoo.dev). The app bundles the pinned `@shoojs/auth` client instead of loading a script from shoo.dev, and signs you out when your token expires or the session is revoked. Each account can only access its own documents, images, and search results.

Open Settings from the avatar menu, or the usage line in the footer. It has three tabs:

- **Usage**: percent of the plan used (`<1%` for any small nonzero spend), reset date and storage. It reloads once uploads finish processing, since storage is counted after S3 receives the file, and whenever the tab is shown again, which also picks up documents an agent added over MCP.
- **Connect agent**: create, rotate or revoke your MCP key and copy the setup for Claude Code or Broods. The key is shown once. See [MCP](../README.md#mcp).
- **Account**: **Delete all my data**, which deletes every document, image and tag in the account and resets storage to 0. Usage already spent in the current cycle stays.

## Documents

One toolbar holds the status filters (All, Indexed, Processing, Failed, Ready) with their counts, the search box, Add files, Sync all and the avatar menu. The document list supports filtering, sorting, pagination, selection, tag editing, deletion, replacement, and retry.

Errors drop down as a notification at the top center of the screen and close after 6 seconds or with ×. A failed document list or usage load has a Retry button and stays until you retry or close it. A failed detail load closes the detail panel. Every row is one line of fixed height. A document's own processing error shows on its status badge: hover it to read the error.

Upload PDF, Markdown, text, JPEG, PNG, WebP, and GIF files. Images over 5 MiB and other files over 50 MiB are rejected before upload. Newly uploaded files remain visible while processing continues in the background.

Completed or failed documents can be replaced. Existing content remains searchable until the replacement upload is accepted.

While any document is processing, the list refreshes every 3 seconds. It pauses in hidden tabs and catches up when the tab is shown again. Only the newest response is applied, and a refresh keeps every row that did not change as it was, so an unsaved tag edit survives it. Search filters as you type. A new search returns to the first page and clears the selection; a new sort returns to the first page.

## Search

The web app has no semantic search panel. Search your content from Claude Code, Broods or another MCP 2026-07-28 client, or call `POST /query` with text, one supported image up to 5 MiB, or both.

## Analytics

When the deployment sets a PostHog key, the app records which actions you take (sign in, upload, search, delete, reindex, delete all data) and the errors you see, under your account. Titles, search text and document content are never sent.

PostHog starts loading once the first screen has rendered, and events from before then are sent once it loads. Starting sign-in loads it at once if needed and hands it the sign-in event before the redirect, waiting at most a second. Signing out, or an expired session, removes your PostHog identity from this browser immediately, whether or not PostHog has loaded. PostHog keeps its ids in localStorage, with no cookie. Without a key the build contains no PostHog code.

## Loading

The first screen downloads only what it shows. A signed-out visitor gets the sign-in card; the workspace (documents and settings) and its libraries load as separate chunks once you are signed in, and pdf.js only when you add a PDF. A stored session is read before the first paint, so a signed-in user never sees the sign-in card first. Third-party libraries live in long-cached `vendor` and `vendor-workspace` chunks, so a deploy that changes only app code re-downloads about 30 kB of compressed JavaScript. The page also opens its connection to the API while the JavaScript downloads.

## Development

Point the dev server at a non-production stage. Production rejects tokens issued to localhost.

```bash
cd web
API_URL=https://<stage-api-url>/v1 npm run dev
```

Uploads from localhost also need `VITE_STORAGE_ORIGIN` and an S3 CORS rule for localhost, so test uploads on the deployed web app.
