import { Context } from 'hydrooj';
import { JudgeSettings, overrideConfig } from './config';

export const Config = JudgeSettings;

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
    overrideConfig(config);
    // CLI processes exit after their command; only the running server should consume tasks.
    if (process.env.HYDRO_CLI || process.env.NODE_APP_INSTANCE !== '0') return;
    // eslint-disable-next-line consistent-return
    if (!config.disable) return require('./hosts/builtin').apply(ctx);
}
