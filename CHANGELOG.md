# Changelog

## 0.1.51

- Batch remote content verification by directory (up to 32 files), reuse directory listings within each batch, and revalidate files and parent paths with fresh listings before committing hashes or shared baselines.
- Compute remote CRC32 directly from FTP, FTPS, and SFTP streams without comparison files on disk; overlap local hashing/scanning with remote work while keeping FTP commands sequential.
- Checkpoint verified cache progress during long comparisons and preserve completed batches on cancellation or failure. Existing cache files remain compatible.
- Avoid unnecessary content reads for empty files and bidirectional size differences that can already be classified against synchronization history; report byte progress for long remote comparisons.
- Add regression coverage for reduced listing counts, cached reruns, partial-cache recovery, concurrent remote changes, symlink replacement, truncated transfers, and streaming checksums across supported transports.

## 0.1.50

- Replace the WSFTP Sync Output content with the latest status line when debug is false, avoiding manual scrolling; keep appending full diagnostics when debug is true.

## 0.1.49

- Use compact local-time [HH:mm:ss] log timestamps and remove the repeated workspace, protocol, host, and port prefix from session messages.

## 0.1.48

- Automatically reveal the WSFTP Sync Output channel when a manual synchronization initializes the local cache, preserving editor focus.
- Log comparison counts and paths during initial synchronization and report when the cache has been saved.

## 0.1.47

- Show "Creating the local cache. This may take a few minutes." during manual synchronization comparisons when no valid saved cache is available; retain the usual comparison message for subsequent runs.

## 0.1.46

- Keep template ignore_always rules first when importing legacy configuration, then append and deduplicate rules from ignore_always, ignore, and ignored, including when legacy lists are empty.
- Convert common legacy dot-directory, filename, and slash-delimited directory expressions to recursive globs; preserve complex expressions in the supported regex format.

## 0.1.45

- Import legacy login and path fields as username and remote_path when creating a missing workspace configuration from ftp-sync.json, alongside host, password/pass, port, and ignore filters.
- Preserve explicit current field names and prefer remotePath over path when multiple legacy aliases are present.

## 0.1.44

- Show an immediate connection progress notification with the target host and port for manual transfers and synchronization, closing it before reporting connection failures.
- Show remote inspection and transfer progress for single-file operations while keeping background checks and upload on save quiet.

## 0.1.43

- Explain that a login rejection can come from an incorrect but reachable host, and prompt users to verify the hostname/IP before credentials.
- Require explicit authentication failure evidence and prioritize secure-connection errors over authentication wording.

## 0.1.42

- Distinguish unknown hostnames, temporary DNS failures, unreachable hosts/IP addresses, refused connections, and connection timeouts with specific troubleshooting hints.

## 0.1.41

- Seed new workspace configurations from .vscode/ftp-sync.json, importing common settings and converting legacy ignore expressions while keeping discovery enabled.
- Preserve existing configurations and the legacy source; report malformed or incompatible imports without exposing credentials.

## 0.1.40

- Report specific connection, login, secure connection, remote listing, transfer, directory creation, deletion, and disconnect failures with relevant troubleshooting hints.
- Preserve the original operation failure when disconnect also fails; keep server diagnostics in the credential-redacted log.

## 0.1.39

- Replace persistent automatic-check popups with transient notifications that close after five seconds or before the next scan, preventing stacked notices.
- Keep synchronization review available through the workspace status-bar item.

## 0.1.38

- Correct the three shortcuts to Ctrl+Alt+U, Ctrl+Alt+D, and Ctrl+Alt+S for root upload, root download, and bidirectional synchronization; remove Ctrl+Win bindings.

## 0.1.37

- Keep only Ctrl+Win+U, Ctrl+Win+D, and Ctrl+Win+S as extension shortcuts, for root upload, root download, and bidirectional synchronization respectively.
- Root upload/download previews copy new or modified files and create missing directories without deleting destination-only content.
- Remove all Ctrl+Alt and platform-specific alternative bindings; dominance commands remain accessible without shortcuts.

## 0.1.36

- Add Ctrl+Alt+S (Cmd+Alt+S on macOS) as an alternative shortcut for manual bidirectional synchronization because Windows can intercept Win+Ctrl+S.
- Document the Command Palette fallback and clarify that manual synchronization does not require autosync.

## 0.1.35

- Rename the remotePath configuration key to remote_path in validation, discovery, schema, and the bundled example.
- Update transfers, synchronization, cache identity, and documentation to use the new field; existing configurations must rename the key.

## 0.1.34

- Add autosync_secs to the plugin JSON configuration, defaulting to 120 seconds (two minutes).
- Validate integer intervals from 1 to 86400 seconds and adapt scheduling for intervals below the previous 15-second polling cadence without overlapping checks.
- Replace the former VS Code intervalMinutes setting and apply saved interval changes without reloading.

## 0.1.33

- Add the boolean autosync option to the plugin JSON configuration and schema, with false in the bundled example.
- Give explicit autosync values precedence over the existing VS Code automatic-check setting while preserving the fallback when omitted.
- Update the toggle command to edit autosync in the plugin configuration; detect saved and external configuration changes.

## 0.1.32

- Add optional workspace automatic checks, a toggle command, and a configurable 1?60 minute interval (five minutes by default).
- Show per-workspace synchronization counts and notify only about newly detected differences; open a fresh bidirectional preview for review.
- Require two stable remote observations, avoid overlapping checks, yield to manual operations, and cancel checks when disabled or disposed.
- Keep background checks read-only for workspace/server content and suppress interactive credential, discovery, and trust prompts.

## 0.1.31

- Add Win+Ctrl+U for local dominance, Win+Ctrl+D for remote dominance, and Win+Ctrl+S for bidirectional synchronization.
- Preview destination-only file and directory deletions in dominance modes; remove directories only when empty and preserve ignored descendants.
- Persist the last agreed content fingerprint to route bidirectional changes and skip conflicts, without deleting one-sided files.
- Revalidate previews and individual operations, retain completed synchronization history, and preserve history when clearing cached hashes.

## 0.1.30

- Persist local and remote CRC32 values with relative paths, modification times, and sizes; reuse hashes while metadata is unchanged.
- Isolate caches by workspace, server, and remote root; retain pending differences after cancelled previews.
- Invalidate transferred files, prune missing entries within scanned directories, and add a command to clear the synchronization cache.

## 0.1.29

- Document the four-step size/CRC32 synchronization strategy, temporary verification downloads, and the scope of direct file uploads.
- Clarify that modification-time differences do not trigger transfers and no synchronization cache is used.

## 0.1.28

- Ignore modification-time differences when comparing local and remote files: transfer missing or different-size files immediately and compare equal-size contents using CRC32.
- Fix repeated synchronization differences after uploads to servers that assign or truncate remote timestamps, without a synchronization cache.
- Simplify the example exclusions using equivalent Perl-compatible regexes.

## 0.1.27

- Add PCRE2 Perl-compatible regex filters in /pattern/flags form to all three ignore lists while preserving paths and globs.
- Validate regexes with indexed configuration errors, preserve regex escapes, and cache compiled patterns with bounded matching work.
- Bundle the WebAssembly engine for offline Windows/VS Code use without native dependencies.

## 0.1.26

- Prompt to verify and trust self-signed FTPS certificates by SHA256 fingerprint before sending credentials.
- Remember accepted certificates per host and port for discovery and transfers; require renewed trust for changed certificates.
- Stop discovery on certificate rejection and require manual verification before automatic uploads to an untrusted server.
- Verify data connections against the accepted certificate and add TLS-required discovery and self-signed transfer regression coverage.

## 0.1.25

- Remove all hardcoded path exclusions and automatic key-file exclusions. Only configured ignore_always, ignore_upload, and ignore_download rules filter paths.
- Treat example exclusions as editable suggestions; empty or omitted lists exclude nothing.

## 0.1.24

- Silently suspend all operations when username, password, or host is missing, null, empty, or whitespace-only.
- Apply this prerequisite before discovery, transfers, credential prompts, and further configuration validation.

## 0.1.23

- Initialize missing .vscode/wsftp-sync.json files from the bundled example only when .vscode exists, without overwriting existing files.
- Silently suspend discovery, transfers, and further configuration validation when username is missing or blank.
- Use the same template for the explicit configuration command.

## 0.1.22

- Accept only the 13 configuration keys present in the example; reject all other options and legacy aliases.
- Align JSON schema and documentation with the exact supported set. Keep the connection timeout fixed at 15 seconds and certificate verification enabled.

## 0.1.21

- Reject uploadOnSave as an invalid configuration option; require upload_on_save.
- Report a single unrecognized field as invalid option followed by its name, while retaining combined reports for multiple unknown fields.

## 0.1.20

- Keep discover in the configuration after successful detection and set it to false; include the updated value in the confirmation popup.

## 0.1.19

- Keep passive in the configuration after discovery, setting it to false for SFTP, and show that value in the confirmation popup.

## 0.1.18

- Automatically apply successful discovery settings to .vscode/wsftp-sync.json and remove discover; remove passive for SFTP.
- Confirm the saved settings in a popup and include the interception warning for FTP. Preserve unrelated settings and refuse to overwrite concurrent or unsaved edits.

## 0.1.17

- Try SFTP first during discovery, then FTPS, and finally FTP, stopping at the first working protocol/data mode.
- Preserve the settings popup, removal reminder, and unencrypted FTP security warnings.

## 0.1.16

- Add discover mode to test FTPS passive/active, SFTP, and FTP passive/active on the configured port using authentication and directory listing only.
- Show suggested settings and a reminder to remove discover; suspend transfers while discovery is enabled.
- Require explicit approval before unencrypted FTP attempts and repeat the credential-interception warning for FTP results.
- Preserve TLS and SSH host verification during discovery, with cancellation, diagnostics, and connection cleanup.

## 0.1.15

- Remove the secure configuration option; protocol alone selects SFTP, explicit FTPS, or unencrypted FTP.
- Reject secure as an unknown option and update the example and migration documentation to use protocol: ftps.

## 0.1.14

- Accept both boolean values for passive: true uses EPSV/PASV, while false uses active FTP with PORT/EPRT and never sends passive commands.
- Support active FTP/FTPS directory listings, uploads, and downloads with data-connection TLS, timeouts, peer checks, and listener cleanup.
- Document active-mode connectivity requirements and preserve passive mode as the default.

## 0.1.13

- Load configuration exclusively from .vscode/wsftp-sync.json in each workspace folder; never fall back to the workspace-root example.
- Update configuration guidance and schema association to require the .vscode location.
- Include all built-in exclusions in the example configuration.

## 0.1.12

- Read only wsftp-sync.json from .vscode or the workspace root; remove ftp-sync.json and wsftp.json discovery and schema associations.
- Report all unknown configuration options together, including unsupported secureOptions fields, without exposing their values.

## 0.1.11

- Use upload_on_save, ignore_always, ignore_upload, and ignore_download in examples, generated configuration, schema descriptions, and documentation.
- Accept uploadOnSave for compatibility while giving upload_on_save precedence, including an explicit false value.

## 0.1.10

- Support wsftp-sync.json in the workspace root or .vscode, including ignoreAlways, ignoreUpload, and ignoreDownload exclusions with compatibility aliases and FTP-compatible settings.
- Enable credential-redacted FTP/FTPS commands, server replies, SFTP diagnostics, and operation logs in the Debug Console when debug is true.
- Document every configuration option, defaults, compatibility behavior, and debug output.

## 0.1.9

- Translate all extension commands, prompts, errors, logs, and configuration descriptions into English.

- Immediately schedule transfers when file size or modification time differs, skipping content reads, temporary downloads, and CRC32 verification.
- Reserve CRC32 verification for files with exactly matching size and modification time in both synchronization directions.

## 0.1.8

- Compare every equal-size file pair using streaming CRC32, even when modification times match.
- Use size differences directly and keep timestamps for diagnostics and concurrent-change checks.
- Log local and remote CRC32 values and comparison reasons.

## 0.1.7

- Verify SHA256 content when equal-size files have different timestamps, preventing repeated uploads of identical files after the server changes their modification time.
- Apply verification to both sync directions, with temporary-file cleanup and metadata revalidation during comparison.

## 0.1.6

- Show a specific English message for invalid configuration JSON, including the affected filename without exposing file contents.
- Distinguish JSON syntax errors from configuration file read errors.

## 0.1.5

- Translate project documentation and release notes into English and establish English as the language for developer-facing text.
- Document the Output logging added in 0.1.4 and update installation instructions.

## 0.1.4

- Add timestamps, connection details, scans, synchronization comparisons, transfers, and operation results to the WSFTP Sync Output channel.
- Log exclusions, cancellations, and errors with credentials redacted from diagnostic details.

## 0.1.3

- Add `ignore_upload` and `ignore_download` to exclude paths and globs in the specified direction across all commands and upload on save.

## 0.1.2

- Compare from the workspace root with an Apply/Cancel modal preview using Ctrl+Alt+U/D.
- Add Explorer Upload dir and Download dir commands that scan only the selected directory.
- Use a single confirmation to transfer all listed files.

## 0.1.1

- Support `.vscode/ftp-sync.json`, legacy credentials, FTPS through `secure`, certificate options, and `ignore` filters.
- Add Ctrl+Alt+U and Ctrl+Alt+D upload/download shortcuts (Cmd on macOS).
- Report configuration errors and unmet automatic-upload prerequisites.

## 0.1.0

- Initial release with SFTP, FTP, and explicit FTPS support.
- Add individual upload/download, upload on save, and SecretStorage credentials.
- Add recursive directional synchronization with a selectable preview and confirmation.
- Support exclusions, host key/TLS verification, temporary-file downloads, and multi-root workspaces.
