import type { Context } from '../context';
import { ensureSystemMembership } from '../upgrade';

// Repair installations that have already passed the upstream v4 -> v5 migration.
// Use a separate channel so future upstream core migration numbers stay intact.
export function apply(ctx: Context) {
    if (process.env.HYDRO_CLI) return;
    ctx.inject(['migration'], (c) => c.migration.registerChannel('hgnu-system-membership', [ensureSystemMembership]));
}
