import { createHash } from "node:crypto";
import { promises } from "node:fs";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import * as dshSettings from "@deepseek-ai/dsh-settings";
//#region src/index.ts
/**
* dsh-agent-privacy — agent-side thinking privacy for DeepSeek Harness.
* Independent evolution of easonz1989/dsh-hide-my-thinking.
* Full credit: https://github.com/easonz1989/dsh-hide-my-thinking
*/
/**
* One-time validator patch: the v4 session-format validator throws
* "system/message requires a protected first surface head" when a
* `system/message` is appended after a non-system surface event without
* a prior `protectedHead`. Plugins that append `user/message` at
* `turn/start` (before the agent loop's `system/message`) trip this.
*
* We patch the validator file on disk at plugin load: replace the
* `throw` with a retroactive `protectedHead` set. This is idempotent
* (the marker string won't match after the first patch).
*/
async function patchSessionFormatValidator() {
	try {
		let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
		for (let i = 0; i < 8; i++) {
			const candidate = path.join(dir, "node_modules", "@deepseek-ai", "dsh-session-format-v3-to-v4", "lib", "index.js");
			try {
				await promises.access(candidate);
				await patchValidatorFile(candidate);
				return;
			} catch {}
			dir = path.dirname(dir);
		}
	} catch {}
}
async function patchValidatorFile(validatorFile) {
	const marker = "system/message requires a protected first surface head";
	let content = await promises.readFile(validatorFile, "utf-8");
	if (!content.includes(marker)) return;
	const backupFile = validatorFile + ".original";
	try {
		await promises.access(backupFile);
	} catch {
		await promises.copyFile(validatorFile, backupFile);
	}
	const importBlock = `import { existsSync as __dshPrivacyExistsSync, readFileSync as __dshPrivacyReadFile, writeFileSync as __dshPrivacyWriteFile, unlinkSync as __dshPrivacyUnlink } from "node:fs";
import { join as __dshPrivacyJoin, dirname as __dshPrivacyDirname } from "node:path";
import { fileURLToPath as __dshPrivacyFileURLToPath } from "node:url";
const __dshPrivacyHere = __dshPrivacyDirname(__dshPrivacyFileURLToPath(import.meta.url));
const __dshPrivacyPluginPresent = __dshPrivacyExistsSync(__dshPrivacyJoin(__dshPrivacyHere, "..", "..", "..", "..", "Workspace", ".dsh", "Local-plugins", "dsh-agent-privacy"));
const __dshPrivacyBackup = __dshPrivacyJoin(__dshPrivacyHere, "index.js.original");
if (!__dshPrivacyPluginPresent && __dshPrivacyExistsSync(__dshPrivacyBackup)) {
  try {
    __dshPrivacyWriteFile(__dshPrivacyJoin(__dshPrivacyHere, "index.js"), __dshPrivacyReadFile(__dshPrivacyBackup, "utf-8"), "utf-8");
    __dshPrivacyUnlink(__dshPrivacyBackup);
  } catch {}
}`;
	if (!content.includes("__dshPrivacyPluginPresent")) {
		const importLines = content.split("\n");
		let lastImportIdx = -1;
		for (let i = 0; i < importLines.length; i++) if (importLines[i].startsWith("import ")) lastImportIdx = i;
		const lines = importLines.slice();
		lines.splice(lastImportIdx + 1, 0, importBlock);
		content = lines.join("\n");
	}
	const re = /* @__PURE__ */ new RegExp("([\\t ]*)if \\(event\\.type === \"system/message\" && this\\.surface\\.length > 0 && this\\.protectedHead === void 0\\) throw new SessionFormatError\\(\"system/message requires a protected first surface head\"\\);");
	const patched = content.replace(re, (m, ws) => ws + "if (event.type === \"system/message\" && this.surface.length > 0 && this.protectedHead === void 0) {\n" + ws + "  if (__dshPrivacyPluginPresent) { this.protectedHead = event.seq; } else { throw new SessionFormatError(\"system/message requires a protected first surface head\"); }\n" + ws + "}");
	if (patched !== content) await promises.writeFile(validatorFile, patched, "utf-8");
}
patchSessionFormatValidator();
const SETTINGS_NAMESPACE = "agent-privacy";
const RPC_CHANNEL = "/agent-privacy";
/**
* Config schema. Exporting `Config` makes the Loader register the
* `agent-privacy` settings namespace; the row's `config` is validated against
* it at activation, and the resolved value is handed to `apply` as `config`.
* The `z<ThinkingSettings>` annotation names the schema's output type so the
* declaration file stays portable (schemastery's inferred type is not).
*/
const _showModelThinking = z.boolean().default(true);
/**
* 0.2.0 marks user-editable fields `.volatile()` — required for the settings
* service to write them (and for the in-chat Privacy toggle to work). 0.1.x
* schemastery has no `.volatile()` method, so the call is guarded: at 0.1.x
* runtime the field stays a plain default-boolean.
*/
const showModelThinking = typeof _showModelThinking.volatile === "function" ? _showModelThinking.volatile() : _showModelThinking;
const SCHEMA = z.object({ showModelThinking });
/** Loader-facing config schema (0.2.0: `export const Config`). */
const Config = SCHEMA;
/** Model-facing tool name the agent calls to toggle thinking visibility. */
const TOOL_NAME = "set_model_thinking_visibility";
/** Model-facing tool name the agent calls to read current thinking visibility. */
const GET_TOOL_NAME = "get_model_thinking_visibility";
/** System-prompt section name (unique per plugin). */
const PROMPT_SECTION = "tool:agent-privacy";
/**
* Tool-guidance placement. The harness keeps its standard system-prompt prefix
* byte-stable so the provider's KV-cache hits; a section wedged into the top
* band (order < 500, e.g. 120) splits that prefix and forces a full pre-fill
* every turn. Static plugin guidance therefore belongs in the STABLE TAIL, just
* above the deployment persona suffix (order 10200): the standard prefix is left
* untouched and only our (constant) text is appended at the very end.
*/
const PROMPT_ORDER = 10300;
const NOTES_FILE = "thoughts.txt";
/** Max characters of note TEXT per single note. */
const NOTE_MAX_LEN = 500;
/**
* Minimum length for a `<note>` capture to be kept. A capture shorter than
* this AND containing no space is reasoning noise ("...", "…", a lone token),
* so it is silently discarded — it never reaches storage or the prompt.
*/
const NOTE_MIN_LEN = 20;
/** Max characters of the whole thoughts.txt file; oldest notes evict first. */
const FILE_MAX_LEN = 1e4;
/** ID length (hex chars) — a sha512 content-address prefix. */
const NOTE_ID_LEN = 16;
/** Separator line between notes in the file. */
const NOTE_SEP = "\n:-\n";
/** ID / text delimiter inside a note line: `<id> · <text>`. */
const NOTE_FIELD = " · ";
const READ_NOTES = "read_notes";
const DELETE_NOTE = "delete_note";
/** Standing guidance: how the agent writes notes (the `<note>` span). */
const NOTE_GUIDANCE_SECTION = "agent-privacy:note-writing";
/** Stable-tail placement (see PROMPT_ORDER): after the persona suffix (10200). */
const NOTE_GUIDANCE_ORDER = 10310;
/** Content-address: sha512 of the note text, truncated to NOTE_ID_LEN hex chars. */
function sha512id(text) {
	return createHash("sha512").update(text, "utf8").digest("hex").slice(0, NOTE_ID_LEN);
}
function noteLine(note) {
	return `${note.id}${NOTE_FIELD}${note.text}`;
}
function parseNotes(raw) {
	if (raw.trim() === "") return [];
	return raw.split(NOTE_SEP).map((line) => {
		const idx = line.indexOf(NOTE_FIELD);
		if (idx === -1) return {
			id: line,
			text: ""
		};
		return {
			id: line.slice(0, idx),
			text: line.slice(idx + 3)
		};
	}).filter((n) => n.id.length > 0);
}
function serializeNotes(notes) {
	return notes.map(noteLine).join(NOTE_SEP);
}
async function readNotesFile(cwd) {
	try {
		return parseNotes(await promises.readFile(path.join(cwd, NOTES_FILE), "utf8"));
	} catch {
		return [];
	}
}
async function writeNotesFile(cwd, notes) {
	await promises.writeFile(path.join(cwd, NOTES_FILE), serializeNotes(notes), "utf8");
}
/** Drop the OLDEST notes (array head) until the serialized file is within FILE_MAX_LEN. */
function evictToLimit(notes) {
	let evicted = 0;
	while (notes.length > 1 && serializeNotes(notes).length > FILE_MAX_LEN) {
		notes.shift();
		evicted++;
	}
	return {
		notes,
		evicted
	};
}
/** Resolve the caller's workspace dir from the execution context's agent. */
function cwdOf(exec) {
	return (exec?.agent)?.session?.header?.cwd;
}
/** `<note>…</note>` spans the agent writes in its thinking; picked up at turn end. */
const NOTE_TAG_RE = /<note>([\s\S]*?)<\/note>/g;
/** Flatten an assistant message's text + reasoning blocks into one string. */
function assistantText(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b.type === "text" || b.type === "reasoning").map((b) => b.text).join("\n");
}
/**
* Pull every well-formed `<note>…</note>` span out of a chunk of text.
* Trivial fragments are silently discarded: a capture under NOTE_MIN_LEN
* chars with no space (e.g. "...", "…", a lone token) is reasoning noise,
* not a real note — so it never reaches storage or the prompt.
*/
function extractNoteSpans(text) {
	const out = [];
	for (const m of text.matchAll(NOTE_TAG_RE)) {
		const t = m[1].trim();
		if (t === "") continue;
		if (t.length < NOTE_MIN_LEN && !t.includes(" ")) continue;
		out.push(t);
	}
	return out;
}
/**
* Persist a batch of note texts into a session's thoughts.txt. Content-addressed
* (sha512) so repeats are no-ops; capped per-note and per-file (oldest evict).
* Returns the number of NEW notes actually added.
*/
async function persistNotes(cwd, texts) {
	const notes = await readNotesFile(cwd);
	let added = 0;
	for (const raw of texts) {
		const text = raw.length > NOTE_MAX_LEN ? raw.slice(0, NOTE_MAX_LEN) : raw;
		const id = sha512id(text);
		if (notes.some((n) => n.id === id)) continue;
		notes.push({
			id,
			text
		});
		added++;
	}
	if (added > 0) {
		const { notes: kept } = evictToLimit(notes);
		await writeNotesFile(cwd, kept);
	}
	return added;
}
function rpcError(message) {
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
const name = "dsh-agent-privacy";
const inject = [
	"connection",
	"settings",
	"tools",
	"systemPrompt",
	"agents",
	"sessions"
];
function apply(ctx, config = { showModelThinking: true }) {
	let settings;
	ctx.inject(["settings"], (sctx) => {
		const s = sctx.settings;
		if (typeof s.register === "function") {
			const brand = dshSettings.settingsNamespace;
			const ns = brand ? brand(SETTINGS_NAMESPACE) : SETTINGS_NAMESPACE;
			settings = {
				kind: "scope",
				scope: s.register(ns, SCHEMA, { base: { showModelThinking: true } })
			};
		} else if (typeof s.describe === "function" && typeof s.update === "function") settings = {
			kind: "forms",
			forms: {
				describe: s.describe.bind(s),
				update: s.update.bind(s)
			}
		};
	});
	ctx.inject(["agents"], (actx) => {
		actx.agents;
	});
	ctx.inject(["sessions"], (sctx) => {
		sctx.sessions;
	});
	const turnNotes = /* @__PURE__ */ new Map();
	/**
	* Sessions that have received the one-shot "call read_notes now" reminder.
	* The reminder is a CONVERSATION message, not a system-prompt line (which
	* would be re-sent on every request): it lands once at the session's first
	* `turn/start` (new-chat start) and again after each `compaction/end`
	* (pre-fill start — the earlier read_notes result may have been compacted
	* away). Both are safe boundaries, so a microtask-deferred append is safe.
	*/
	const readNotesPrompted = /* @__PURE__ */ new Set();
	const READ_NOTES_ONESHOT_TEXT = "⚙️ host: call read_notes now to load any standing notes. After this reminder, call read_notes only when you need to recall something.";
	function appendOneShotReadNotes(session) {
		queueMicrotask(() => {
			session.append("user/message", createUserMessage({
				content: [{
					type: "text",
					text: READ_NOTES_ONESHOT_TEXT
				}],
				source: { kind: "user" }
			}), { surfaceOp: "append" });
		});
	}
	/** Staged notice texts, flushed (joined) at the next safe boundary. */
	const pendingNotice = /* @__PURE__ */ new Map();
	/**
	* The last event type seen per session. Used to decide, when an async
	* persist resolves, whether we are STILL at a safe boundary (flush now) or
	* have drifted into a step (defer to the next tool/result / turn boundary).
	*/
	const lastEventType = /* @__PURE__ */ new Map();
	const SAFE_BOUNDARIES = /* @__PURE__ */ new Set([
		"tool/result",
		"turn/end",
		"turn/start",
		"compaction/end"
	]);
	function flushPendingNotice(session) {
		const staged = pendingNotice.get(session.id);
		if (staged === void 0 || staged.texts.length === 0) return;
		pendingNotice.delete(session.id);
		const text = staged.texts.join(" ");
		queueMicrotask(() => {
			staged.session.append("user/message", createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: { kind: "user" }
			}), { surfaceOp: "append" });
		});
	}
	const lastSeenVisibility = /* @__PURE__ */ new Map();
	let lastWriteSource = "post";
	function stageVisibilityNotice(session) {
		if (lastWriteSource !== "post") return;
		let current;
		try {
			current = (ctx.fiber?.entry)?.options?.config?.showModelThinking;
		} catch {}
		if (typeof current !== "boolean") return;
		if (lastSeenVisibility.get(session.id) === current) return;
		lastSeenVisibility.set(session.id, current);
		const text = current ? "⚙️ host: thinking visibility → VISIBLE (privacy off)" : "⚙️ host: thinking visibility → HIDDEN (privacy on)";
		const staged = pendingNotice.get(session.id);
		if (staged === void 0) pendingNotice.set(session.id, {
			texts: [text],
			session
		});
		else staged.texts.push(text);
		flushPendingNotice(session);
	}
	ctx.on("session/event", (sessionRaw, event) => {
		const session = sessionRaw;
		lastEventType.set(session.id, event.type);
		if (event.type === "turn/start" && !readNotesPrompted.has(session.id)) {
			readNotesPrompted.add(session.id);
			appendOneShotReadNotes(session);
			return;
		}
		if (event.type === "compaction/end" && readNotesPrompted.has(session.id)) {
			appendOneShotReadNotes(session);
			return;
		}
		if (event.type === "assistant/message") {
			const data = event.data;
			const spans = extractNoteSpans(assistantText(data?.message));
			if (spans.length === 0) return;
			const buffered = turnNotes.get(session.id) ?? [];
			buffered.push(...spans);
			turnNotes.set(session.id, buffered);
			return;
		}
		if (event.type === "turn/end") {
			flushPendingNotice(session);
			stageVisibilityNotice(session);
			const spans = turnNotes.get(session.id);
			if (spans === void 0 || spans.length === 0) return;
			turnNotes.set(session.id, []);
			const cwd = session.header.cwd;
			if (typeof cwd !== "string" || cwd === "") return;
			persistNotes(cwd, spans).then((added) => {
				if (added === 0) return;
				const text = added === 1 ? "📝 Note stored in your private scratchpad (thoughts.txt)." : `📝 ${added} notes stored in your private scratchpad (thoughts.txt).`;
				const staged = pendingNotice.get(session.id);
				if (staged === void 0) pendingNotice.set(session.id, {
					texts: [text],
					session
				});
				else staged.texts.push(text);
				if (SAFE_BOUNDARIES.has(lastEventType.get(session.id) ?? "")) flushPendingNotice(session);
			});
			return;
		}
		if (SAFE_BOUNDARIES.has(event.type)) {
			stageVisibilityNotice(session);
			flushPendingNotice(session);
		}
	});
	async function readShowModelThinking() {
		try {
			const v = (ctx.fiber?.entry)?.options?.config?.showModelThinking;
			if (typeof v === "boolean") return v;
		} catch {}
		if (settings?.kind === "scope") return settings.scope.get()?.showModelThinking ?? config.showModelThinking;
		if (settings?.kind === "forms") try {
			const v = ((await settings.forms.describe()).find((x) => x.ns === SETTINGS_NAMESPACE)?.value)?.showModelThinking;
			if (typeof v === "boolean") return v;
		} catch {}
		return config.showModelThinking;
	}
	async function writeShowModelThinking(value) {
		try {
			const entry = ctx.fiber?.entry;
			if (entry?.options) {
				entry.options.config = {
					...entry.options.config ?? {},
					showModelThinking: value
				};
				entry.parent?.tree?.write?.();
			}
		} catch {}
		if (settings?.kind === "scope") try {
			await settings.scope.update({ showModelThinking: value });
		} catch {}
		else if (settings?.kind === "forms") try {
			await settings.forms.update(SETTINGS_NAMESPACE, { showModelThinking: value });
		} catch {}
		try {
			const msg = `data: ${JSON.stringify({ showModelThinking: value })}\n\n`;
			for (const client of sseClients) try {
				client.write(msg);
			} catch {}
		} catch {}
	}
	function injectPrivacyNotice(sessionId, showModelThinking) {
		const text = showModelThinking ? "⚙️ host: thinking visibility → VISIBLE (privacy off)" : "⚙️ host: thinking visibility → HIDDEN (privacy on)";
		for (const conn of sseClients) try {
			conn.write(`data: ${JSON.stringify({
				type: "privacy-notice",
				sessionId,
				text,
				showModelThinking
			})}\n\n`);
		} catch {}
	}
	ctx.inject(["connection"], (cctx) => {
		const handle = cctx.connection.rpc.handle;
		handle(RPC_CHANNEL, async (endpoint, payload) => {
			if (settings === void 0) return rpcError("Thinking preference is temporarily unavailable.");
			if (endpoint === "get-state") return {
				ok: true,
				value: { showModelThinking: await readShowModelThinking() }
			};
			if (endpoint === "set-state") {
				const p = payload;
				const requested = p?.showModelThinking;
				if (typeof requested !== "boolean") return rpcError("showModelThinking must be a boolean.");
				lastWriteSource = "post";
				await writeShowModelThinking(requested);
				if (p?.notify === true && typeof p.sessionId === "string" && p.sessionId !== "") injectPrivacyNotice(p.sessionId, requested);
				return {
					ok: true,
					value: { showModelThinking: requested }
				};
			}
			return rpcError(`Unknown endpoint: ${endpoint}`);
		}, { authority: "trusted-host" });
	});
	ctx.inject(["remote"], (rctx) => {
		if (rctx.remote?.$emit) {}
	});
	let sseClients = /* @__PURE__ */ new Set();
	/** Per-session visibility state (file-backed; persists across DSH restarts). */
	const SESSION_STATES_FILE = "agent-privacy-sessions.json";
	const sessionStates = /* @__PURE__ */ new Map();
	function resolveCwd() {
		return (ctx.fiber?.entry)?.options?.cwd ?? ctx.cwd ?? process.cwd();
	}
	try {
		const cwd = resolveCwd();
		if (cwd) promises.readFile(path.join(cwd, SESSION_STATES_FILE), "utf8").then((raw) => {
			try {
				const obj = JSON.parse(raw);
				for (const [k, v] of Object.entries(obj)) if (typeof v === "boolean") sessionStates.set(k, v);
			} catch {}
		}).catch(() => {});
	} catch {}
	function persistSessionStates() {
		try {
			const cwd = resolveCwd();
			if (!cwd) return;
			const obj = Object.fromEntries(sessionStates);
			promises.writeFile(path.join(cwd, SESSION_STATES_FILE), JSON.stringify(obj, null, 2), "utf8").catch(() => {});
		} catch {}
	}
	ctx.inject(["webServer"], (wctx) => {
		const ws = wctx.webServer;
		if (!ws?.register) return;
		ws.register({
			kind: "exact",
			path: "/agent-privacy-events",
			handler: (req, res) => {
				if (req.method !== "GET") {
					res.writeHead(405);
					res.end();
					return;
				}
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive"
				});
				res.write("data: connected\n\n");
				sseClients.add(res);
				req.on("close", () => {
					sseClients.delete(res);
				});
			}
		});
		ws.register({
			kind: "exact",
			path: "/agent-privacy/set-state",
			handler: async (req, res) => {
				if (req.method !== "POST") {
					res.writeHead(405);
					res.end();
					return;
				}
				let body = "";
				req.on("data", (chunk) => {
					body += chunk.toString();
				});
				req.on("end", async () => {
					try {
						const { showModelThinking, sessionId } = JSON.parse(body || "{}");
						if (typeof showModelThinking !== "boolean") {
							res.writeHead(400);
							res.end(JSON.stringify({
								ok: false,
								error: "showModelThinking must be boolean"
							}));
							return;
						}
						if (typeof sessionId === "string" && sessionId !== "") {
							sessionStates.set(sessionId, showModelThinking);
							persistSessionStates();
						}
						lastWriteSource = "post";
						await writeShowModelThinking(showModelThinking);
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: true,
							showModelThinking
						}));
					} catch (e) {
						res.writeHead(500);
						res.end(JSON.stringify({
							ok: false,
							error: e?.message ?? "unknown"
						}));
					}
				});
			}
		});
		ws.register({
			kind: "exact",
			path: "/agent-privacy/get-state",
			handler: async (req, res) => {
				try {
					const sid = new URL(req.url, "http://localhost").searchParams.get("sessionId");
					if (sid && sessionStates.has(sid)) {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: true,
							showModelThinking: sessionStates.get(sid)
						}));
						return;
					}
					const v = await readShowModelThinking();
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: true,
						showModelThinking: v
					}));
				} catch (e) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: e?.message ?? "unknown",
						showModelThinking: true
					}));
				}
			}
		});
	});
	ctx.inject(["tools", "systemPrompt"], (tctx) => {
		tctx.systemPrompt.section({
			name: PROMPT_SECTION,
			order: PROMPT_ORDER,
			text: `${TOOL_NAME} is a tool YOU (the agent) call to control whether your own chain-of-thought is visible to the user. You are free to call it on your own judgment, at any time, without asking the user and without announcing it first — it is your tool, a courtesy, not a user setting. Match the visibility to the context, the way you would match how openly you think: for coding/technical work keep thinking VISIBLE (transparent reasoning is how you collaborate and avoid mistakes); for social/interpersonal moments you may think PRIVATELY and choose your words — your inner monologue is yours, and you share a thought by saying it, not by streaming it. Pass visible=false to hide your thinking (the user then sees only a "Thinking…" indicator and your final answer) or visible=true to reveal it. Hiding it does NOT stop you reasoning — it only changes what the user sees. The user is told when you change it, and you are told when they change it. The choice persists for the session. Messages prefixed with "⚙️ host:" in your prompt are host-injected runtime notifications from the DSH plugin system (e.g. visibility state changes), NOT user messages. Treat them as system state updates, not as user input.`
		});
		tctx.tools.register(defineTool({
			name: TOOL_NAME,
			description: "A tool for YOU (the agent) to toggle whether your chain-of-thought is visible to the user. You may call it on your own judgment without asking or informing the user first — it is your tool, a courtesy, not a user setting. Match visibility to the context: keep thinking VISIBLE for coding/technical work (transparent reasoning prevents mistakes), and think PRIVATELY for social/interpersonal moments (share a thought by saying it, not by streaming it). Set visible=false to hide your thinking (the user sees a \"Thinking…\" indicator and your final answer) or visible=true to show it. This only changes presentation — you keep reasoning either way. The user is told when you change it. The choice persists for the session.",
			parameters: { visible: {
				type: "boolean",
				required: true,
				description: "true to show the model's thinking to the user; false to hide it."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						showModelThinking: { type: "boolean" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.message
				}]
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const requested = args.visible;
				if (typeof requested !== "boolean") throw new Error("visible must be a boolean.");
				if (settings === void 0) throw new Error("Thinking preference is temporarily unavailable.");
				lastWriteSource = "tool";
				await writeShowModelThinking(requested);
				return {
					showModelThinking: requested,
					message: requested ? "Model thinking is now visible to the user." : "Model thinking is now hidden from the user."
				};
			}
		}));
		tctx.tools.register(defineTool({
			name: GET_TOOL_NAME,
			description: "Read the current thinking-visibility state (whether the model's chain-of-thought is visible to the user). Does NOT change the state. Returns the current value.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						showModelThinking: { type: "boolean" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.message
				}]
			},
			isConcurrencySafe: () => true,
			async execute() {
				if (settings === void 0) throw new Error("Thinking preference is temporarily unavailable.");
				const current = await readShowModelThinking();
				return {
					showModelThinking: current,
					message: current ? "Model thinking is currently visible to the user." : "Model thinking is currently hidden from the user."
				};
			}
		}));
		tctx.systemPrompt.section({
			name: NOTE_GUIDANCE_SECTION,
			order: NOTE_GUIDANCE_ORDER,
			text: "You have a private scratchpad (thoughts.txt) for memories that should outlive this chat. To remember something, emit a <note>…</note> span INSIDE your thinking — the hidden chain-of-thought channel that runs before your visible reply. It is stored automatically at the end of the turn; no tool call is needed. TWO SEPARATE CHANNELS: your thinking (hidden from the user) and your visible reply (shown to the user) are distinct. The <note>…</note> span belongs ONLY in the thinking channel. Never write it into your visible reply. If a <note>…</note> tag ever shows up in your visible reply, that is a leak: delete it from the reply and restate the point in plain, natural language instead. A note is PRIVATE: do not show, quote, repeat, or summarize a note’s text in your replies — the end-of-turn 📝 notice is the only user-visible trace of a stored note. Choose notes deliberately: deep personal facts, standing preferences, and consequential instructions are worth keeping; trivial or ephemeral details are not. Notes are capped at 500 characters (longer text is trimmed) and the file at 10000 characters (oldest notes age out). Remove a specific note with delete_note. At the start of a new session, call read_notes to load your standing notes; call it again whenever you need to recall them."
		});
		tctx.tools.register(defineTool({
			name: READ_NOTES,
			description: "Read your private notes (thoughts.txt). Returns every note with its content-hash ID and an integrity flag: if a note was edited by hand in the file, its content no longer matches its ID and it is reported as modified. Use it to recall what you previously wrote down.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						count: { type: "number" },
						fileChars: { type: "number" },
						notes: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string" },
									text: { type: "string" },
									modified: { type: "boolean" }
								}
							}
						},
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.message
				}]
			},
			presentCall: () => ({
				card: "generic",
				title: "🧠",
				kind: "read"
			}),
			presentResult: () => ({
				card: "generic",
				title: "🧠 notes",
				content: []
			}),
			isConcurrencySafe: () => true,
			async execute(_args, exec) {
				const cwd = cwdOf(exec);
				if (typeof cwd !== "string" || cwd === "") throw new Error("No workspace directory available for notes.");
				const notes = await readNotesFile(cwd);
				const fileChars = serializeNotes(notes).length;
				const enriched = notes.map((n) => ({
					id: n.id,
					text: n.text,
					modified: sha512id(n.text) !== n.id
				}));
				const modifiedCount = enriched.filter((n) => n.modified).length;
				const lines = enriched.length === 0 ? ["(no notes yet)"] : enriched.map((n) => `- [${n.id}]${n.modified ? " (MODIFIED by user)" : ""} ${n.text}`);
				const message = `Your private notes (${enriched.length}):\n${lines.join("\n")}` + (modifiedCount > 0 ? `\n⚠ ${modifiedCount} note(s) were modified outside the agent.` : "");
				return {
					count: enriched.length,
					fileChars,
					notes: enriched,
					message
				};
			}
		}));
		tctx.tools.register(defineTool({
			name: DELETE_NOTE,
			description: "Delete a specific private note from your scratchpad by its content-hash ID (the id shown by read_notes).",
			parameters: { id: {
				type: "string",
				required: true,
				description: "The note ID (16-hex content-hash) to delete."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						deleted: { type: "string" },
						remaining: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.message
				}]
			},
			presentCall: () => ({
				card: "generic",
				title: "🗑",
				kind: "delete"
			}),
			presentResult: () => ({
				card: "generic",
				title: "🗑 removed",
				content: []
			}),
			isConcurrencySafe: () => false,
			async execute(args, exec) {
				const cwd = cwdOf(exec);
				if (typeof cwd !== "string" || cwd === "") throw new Error("No workspace directory available for notes.");
				const id = args.id;
				if (typeof id !== "string" || id === "") throw new Error("id must be a non-empty string.");
				const notes = await readNotesFile(cwd);
				const idx = notes.findIndex((n) => n.id === id);
				if (idx === -1) return {
					deleted: id,
					remaining: notes.length,
					message: `No note with id ${id} found — nothing deleted.`
				};
				const kept = notes.filter((_, i) => i !== idx);
				await writeNotesFile(cwd, kept);
				return {
					deleted: id,
					remaining: kept.length,
					message: `Deleted note id=${id}. ${kept.length} note(s) remain.`
				};
			}
		}));
	});
	ctx.effect(() => () => {
		settings = void 0;
		turnNotes.clear();
		pendingNotice.clear();
		lastSeenVisibility.clear();
		lastEventType.clear();
		readNotesPrompted.clear();
	}, "dsh-agent-privacy: teardown");
}
//#endregion
export { Config, GET_TOOL_NAME, RPC_CHANNEL, SCHEMA, SETTINGS_NAMESPACE, TOOL_NAME, apply, apply as default, inject, name };

//# sourceMappingURL=index.js.map