import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface ThinkingSettings {
    showModelThinking: boolean;
}
export declare const SETTINGS_NAMESPACE = "agent-privacy";
export declare const RPC_CHANNEL = "/agent-privacy";
export declare const SCHEMA: z<ThinkingSettings>;
/** Loader-facing config schema (0.2.0: `export const Config`). */
export declare const Config: z<ThinkingSettings>;
/** Model-facing tool name the agent calls to toggle thinking visibility. */
export declare const TOOL_NAME = "set_model_thinking_visibility";
/** Model-facing tool name the agent calls to read current thinking visibility. */
export declare const GET_TOOL_NAME = "get_model_thinking_visibility";
export declare const name = "dsh-agent-privacy";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: ThinkingSettings): void;
export default apply;
