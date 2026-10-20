/**
 * Durable method-mode state: the session-log projection that owns "is the method
 * active for this session, and what is the latest accepted plan", plus the plan
 * path resolution the prompt and the tool both use.
 *
 * DSH refuses a plugin-owned session event type: the persistence read path
 * rejects a log whose event type is outside the generated `KNOWN_SESSION_EVENT_TYPES`
 * set unless the envelope carries `ignorable: true`, and `Session.append()` cannot
 * set that marker. So this unit derives its state entirely from events the
 * surrounding composition already writes:
 *
 *   command/run   name === 'method'      → selection pending, read from `args`
 *   command/done  (paired commandId)     → commit `success`, discard otherwise
 *   tool/call     plan_submit            → remember the call id and its arguments
 *   tool/result   (paired callId)        → a non-error result commits that plan
 *
 * `tool/call.arguments` is the JSON string the model sent, so the plan itself is
 * recoverable from the log without a custom event: the projection re-parses it on
 * commit. Parsing happens at fold time rather than at append time, which means a
 * resumed session rebuilds the exact plan the model submitted.
 *
 * Everything is a pure synchronous fold, so resume, fork, and replay restore the
 * mode from the log alone. `init` runs for the empty log; a unit uninterested in
 * an event returns the same state reference.
 *
 * @module dsh-method/state
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The projection key this unit owns. */
export const PROJECTION_KEY = 'method';

/** Bump whenever the state fields or the fold semantics change. */
export const PROJECTION_VERSION = 1;

/** Directory holding the plan, relative to the project anchor. */
export const PLAN_DIR = '.method';

/** The plan file's name. */
export const PLAN_BASENAME = 'plan.md';

/**
 * DSH's own project-root marker. `@deepseek-ai/dsh-agent-instructions` resolves
 * the project root with `projectRootMarkers` defaulting to `['.git']` and falls
 * back to the session cwd; anchoring the plan the same way keeps it inside the
 * project the instructions come from.
 */
const PROJECT_ROOT_MARKERS = ['.git'];

/**
 * Nearest ancestor of `cwd` carrying a project-root marker, else `cwd` itself.
 * @param {string} cwd - the session working directory.
 * @returns {string} the absolute project anchor.
 */
export function findProjectAnchor(cwd) {
	const start = resolve(cwd);
	let current = start;
	for (;;) {
		for (const marker of PROJECT_ROOT_MARKERS) {
			if (existsSync(join(current, marker))) return current;
		}
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/**
 * Absolute path of the plan file for one working directory.
 * @param {string} cwd - the session working directory.
 * @returns {string} the absolute plan path.
 */
export function resolvePlanPath(cwd) {
	return join(findProjectAnchor(cwd), PLAN_DIR, PLAN_BASENAME);
}

/**
 * Create the plan file's parent directory without going through the tool layer,
 * so the plugin never needs a filesystem grant for its own bookkeeping.
 * @param {string} filePath - the absolute plan path.
 */
export function ensureParentDir(filePath) {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
	} catch {
		// A concurrent creation or an unwritable parent surfaces later as a tool error.
	}
}

/**
 * Whether a value is a plain object (not null, not an array).
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a plain object.
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize the pending-submission map of a persisted cache row. An older row
 * (before concurrency support) carries `pendingCall`/`pendingArguments` instead;
 * it is dropped rather than migrated, because a half-open call from a previous
 * process can never receive its result.
 * @param {unknown} value - the persisted `pending` field.
 * @returns {Map<string, string | null>} call id → arguments JSON.
 */
function normalizePending(value) {
	const pending = new Map();
	if (value === null || typeof value !== 'object') return pending;
	for (const [callId, args] of Object.entries(value)) {
		pending.set(callId, typeof args === 'string' ? args : null);
	}
	return pending;
}

/**
 * Structural validator standing in for the `ZodType` a projection unit declares.
 * The registry only ever calls `parse` on a persisted cache row before seeding a
 * fold, so a throwing `parse` discards that row rather than corrupting state.
 */
const stateSchema = {
	parse(value) {
		if (value === null || typeof value !== 'object') {
			throw new TypeError('method projection state must be an object');
		}
		if (typeof value.active !== 'boolean') {
			throw new TypeError('method projection state.active must be a boolean');
		}
		const running = value.running;
		if (running !== null && running !== undefined) {
			if (typeof running !== 'object' || typeof running.commandId !== 'string' || typeof running.wanted !== 'boolean') {
				throw new TypeError('method projection state.running must be { commandId, wanted } or null');
			}
		}
		return {
			active: value.active,
			running: running === null || running === undefined
				? null
				: { commandId: running.commandId, wanted: running.wanted },
			// Pending submissions are a map so that concurrent `plan_submit` calls
			// (the harness may dispatch tool calls in parallel) each keep their own
			// arguments until their own `tool/result` arrives. The last successful
			// result wins the plan, but no call is mispaired with another's result.
			pending: normalizePending(value.pending),
			// A persisted plan must be a plain object; anything else (an array, a
			// string left by a hand-edited cache) discards the row instead of
			// seeding a fold that later indexing would trip over.
			plan: isPlainObject(value.plan) ? value.plan : null,
			revision: Number.isInteger(value.revision) ? value.revision : 0,
		};
	},
};

/**
 * Parse the model's `plan_submit` arguments into the plan object the rest of the
 * plugin reads. A malformed payload yields `null` rather than throwing: a fold
 * must be total, and a call that failed validation never reaches a successful
 * `tool/result` anyway.
 * @param {string | null} json - the `tool/call.arguments` string.
 * @returns {object | null} the parsed plan, or null.
 */
export function parsePlanArguments(json) {
	if (typeof json !== 'string' || json === '') return null;
	try {
		const parsed = JSON.parse(json);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const plan = parsed.plan;
		if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null;
		return plan;
	} catch {
		return null;
	}
}

/**
 * Build the `method` projection unit.
 * @param {string} commandName - the human command that enters and leaves the mode.
 * @param {string} toolName - the model-facing tool whose success commits a plan.
 * @returns {object} a registry-ready projection definition.
 */
export function createMethodProjection(commandName, toolName) {
	return {
		key: PROJECTION_KEY,
		stateVersion: PROJECTION_VERSION,
		stateSchema,
		init: () => ({
			active: false,
			running: null,
			pending: new Map(),
			plan: null,
			revision: 0,
		}),
		apply(state, event) {
			if (event === null || typeof event !== 'object') return state;
			const data = event.data;
			if (data === null || typeof data !== 'object') return state;
			switch (event.type) {
				case 'command/run': {
					if (data.name !== commandName) return state;
					const args = typeof data.args === 'string' ? data.args : '';
					return { ...state, running: { commandId: String(data.commandId), wanted: args.trim() !== 'off' } };
				}
				case 'command/done': {
					const running = state.running;
					if (running === null || data.commandId !== running.commandId) return state;
					// A failed command handler changed nothing, so the previously
					// committed `active` value stands.
					if (data.kind !== 'success') return { ...state, running: null };
					return { ...state, active: running.wanted, running: null };
				}
				case 'tool/call': {
					if (data.name !== toolName) return state;
					const pending = new Map(state.pending);
					pending.set(String(data.callId), typeof data.arguments === 'string' ? data.arguments : null);
					return { ...state, pending };
				}
				case 'tool/result': {
					const callId = data.message !== null
						&& typeof data.message === 'object'
						&& typeof data.message.toolCallId === 'string'
						? data.message.toolCallId
						: null;
					if (callId === null || !state.pending.has(callId)) return state;
					const pending = new Map(state.pending);
					const args = pending.get(callId);
					pending.delete(callId);
					// A failed submission committed nothing, but its own entry still leaves
					// the map so a later result for the same id cannot resurrect it.
					if (data.message.isError === true) return { ...state, pending };
					const plan = parsePlanArguments(args);
					if (plan === null) return { ...state, pending };
					// Last successful submission wins the plan; each concurrent call is
					// still paired with its OWN result, never another call's.
					return { ...state, pending, plan, revision: state.revision + 1 };
				}
				default:
					return state;
			}
		},
	};
}
