import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PERM, PRIV } from '../packages/hydrooj/src/model/builtin';
import DomainModel from '../packages/hydrooj/src/model/domain';
import db from '../packages/hydrooj/src/service/db';

export async function run() {
    assert.match(db.db.databaseName, /(?:test|upgrade)/i);
    const prefix = `hgnu_access_${randomBytes(4).toString('hex')}`;
    const ids: string[] = [];
    const uid = 2147483600;
    const registered = { _id: uid, priv: PRIV.PRIV_USER_PROFILE };
    const create = async (suffix: string, extra: Record<string, any> = {}) => {
        const id = `${prefix}_${suffix}`;
        ids.push(id);
        await DomainModel.coll.insertOne({
            _id: id, lower: id, owner: 1, name: id,
            roles: { guest: '0', default: PERM.PERM_SUBMIT_PROBLEM.toString() },
            _join: { method: DomainModel.JOIN_METHOD_ALL, role: 'default', expire: null },
            _migratedJoin: true,
            ...extra,
        } as any);
        return id;
    };
    const canSubmit = async (id: string, user = registered) => (
        (await DomainModel.getDomainUser(id, user)).perm & PERM.PERM_SUBMIT_PROBLEM
    ) !== 0n;
    try {
        const legacy = await create('legacy');
        assert.equal(await canSubmit(legacy), true);
        assert.equal(await canSubmit(legacy, { _id: 0, priv: 0 }), false);
        await DomainModel.collUser.insertOne({ domainId: legacy, uid, role: 'default', join: false });
        assert.equal(await canSubmit(legacy), false);
        await DomainModel.collUser.updateOne({ domainId: legacy, uid }, { $set: { join: true } });
        assert.equal(await canSubmit(legacy), true);
        const invited = await create('invited', { _join: { method: DomainModel.JOIN_METHOD_CODE, role: 'default' } });
        assert.equal(await canSubmit(invited), false);
        const fresh = await create('new', { _migratedJoin: false });
        assert.equal(await canSubmit(fresh), false);
        const changed = await create('changed');
        await DomainModel.edit(changed, { _join: { method: DomainModel.JOIN_METHOD_ALL, role: 'default', expire: null } });
        assert.equal((await DomainModel.coll.findOne({ _id: changed }))._migratedJoin, false);
        assert.equal(await canSubmit(changed), false);
        return { passed: 7 };
    } finally {
        await DomainModel.collUser.deleteMany({ domainId: { $in: ids }, uid });
        await DomainModel.coll.deleteMany({ _id: { $in: ids } });
    }
}
