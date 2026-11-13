import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PERM, PRIV } from '../packages/hydrooj/src/model/builtin';
import DomainModel from '../packages/hydrooj/src/model/domain';
import UserModel from '../packages/hydrooj/src/model/user';
import db from '../packages/hydrooj/src/service/db';
import { ensureSystemMembership } from '../packages/hydrooj/src/upgrade';

export async function run() {
    assert.equal(db.db.databaseName, 'hgnuoj_upgrade');
    const id = `hgnu_v5_${randomBytes(4).toString('hex')}`;
    const uids: number[] = [];
    try {
        for (const suffix of ['a', 'b']) {
            uids.push(await UserModel.create(`${id}${suffix}@invalid.local`, `${id}${suffix}`, randomBytes(24).toString('hex')));
        }
        const uid = uids[0];
        const registered = { _id: uid, priv: PRIV.PRIV_USER_PROFILE };
        await DomainModel.coll.insertOne({
            _id: id, lower: id, owner: 1, name: id,
            roles: { guest: '0', default: PERM.PERM_SUBMIT_PROBLEM.toString(), teacher: PERM.PERM_SUBMIT_PROBLEM.toString() },
            _join: { method: DomainModel.JOIN_METHOD_ALL, role: 'default', expire: null },
            _migratedJoin: true,
        } as any);
        const role = async (u = registered) => (await DomainModel.getDomainUser(id, u)).role;
        assert.equal(await role(), 'guest');
        assert.equal(await role({ _id: 0, priv: 0 }), 'guest');
        assert.equal((await DomainModel.getDictUserByDomainId(uid))[id], undefined);
        await DomainModel.setUserInDomain(id, uid, { role: 'default', join: true });
        assert.equal(await role(), 'default');
        assert.equal((await DomainModel.getDictUserByDomainId(uid))[id].join, true);
        await DomainModel.setJoin(id, uid, false);
        assert.equal(await role(), 'guest');
        assert.equal((await DomainModel.getDictUserByDomainId(uid))[id], undefined);
        await DomainModel.setUserInDomain(id, uid, { role: 'teacher', join: false });
        assert.equal(await role(), 'guest');
        await DomainModel.setJoin(id, uid, true);
        assert.equal(await role(), 'teacher');
        await DomainModel.setUserInDomain(id, uid, { role: 'guest', join: false });
        await DomainModel.collUser.deleteMany({ domainId: 'system', uid: { $in: uids } });
        await ensureSystemMembership();
        assert.equal(await DomainModel.collUser.countDocuments({ domainId: 'system', uid: { $in: uids }, join: true }), 2);
        await ensureSystemMembership();
        assert.equal(await DomainModel.collUser.countDocuments({ domainId: 'system', uid: { $in: uids } }), 2);
        const blocked = await DomainModel.collUser.findOne({ domainId: id, uid });
        assert.equal(blocked.join, false);
        assert.equal(blocked.role, 'guest');
        assert.equal(await DomainModel.getMultiUserInDomain(id, { join: true }).count(), 0);
        return { passed: 14, policy: 'official-v5', systemRepair: 'per-user-idempotent' };
    } finally {
        await DomainModel.collUser.deleteMany({ uid: { $in: uids } });
        await UserModel.coll.deleteMany({ _id: { $in: uids } });
        await DomainModel.coll.deleteOne({ _id: id });
    }
}
