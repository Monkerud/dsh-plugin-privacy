/**
 * dsh-agent-privacy (client) — in-chat privacy switch + settings row.
 * Independent evolution of easonz1989/dsh-hide-my-thinking.
 * Full credit: https://github.com/easonz1989/dsh-hide-my-thinking
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-agent-privacy";
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<void>;
