import { workspaceLists } from "./access";
import { db } from "./db";
import { type Link, type Remote, type Service, applyLocal, fingerprint, plan } from "./sync";
import type { Task } from "./tasks";

export type Adapter = {
  pull: (links: Link[]) => Promise<Remote[]>;
  create: (t: Task, list: string) => Promise<string>;
  update: (remoteId: string, t: Task, list: string) => Promise<void>;
  remove: (remoteId: string) => Promise<void>;
  done?: () => Promise<void>; // after a successful sync, e.g. to keep Google's sync token
};

const owner = (workspace: string) => (workspace.startsWith("o:") ? [null, workspace.slice(2)] : [workspace.slice(2), null]);

// Pulls the service's changes into the lists, then pushes ours out. One sync per workspace and service at a time.
export async function runSync(workspace: string, service: string, svc: Service, a: Adapter) {
  const lock = await db.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [
      `${workspace}:${service}`,
    ]);
    if (!got.rows[0].ok) return { pulled: 0, pushed: 0, busy: true };
    try {
      let lists = await workspaceLists(workspace);
      const links = (
        await db.query<Link>(`select "taskId", "remoteId", hash from sync_map where workspace = $1 and service = $2`, [
          workspace,
          service,
        ])
      ).rows;
      const p = plan(lists, links, await a.pull(links), svc, () => crypto.randomUUID().slice(0, 8));

      if (p.adds.length && !lists.length) {
        await db.query(`insert into list (id, "userId", "organizationId", name, tasks) values ($1, $2, $3, 'Inbox', '[]')`, [
          crypto.randomUUID(),
          ...owner(workspace),
        ]);
        lists = await workspaceLists(workspace);
      }
      // Local edits and the new mapping land together, so a failed sync can't leave tasks without links.
      const link = (l: Link) =>
        lock.query(
          `insert into sync_map (workspace, service, "taskId", "remoteId", hash) values ($1, $2, $3, $4, $5)
           on conflict (workspace, service, "taskId") do update set "remoteId" = $4, hash = $5`,
          [workspace, service, l.taskId, l.remoteId, l.hash],
        );
      await lock.query("begin");
      try {
        for (const l of applyLocal(lists, p, "Inbox")) {
          const r = await lock.query(
            `update list set tasks = $3, version = version + 1, "updatedAt" = now() where id = $1 and version = $2`,
            [l.id, l.version, JSON.stringify(l.tasks)],
          );
          if (!r.rowCount) throw new Error("A list changed while syncing. Try again.");
        }
        await lock.query(`delete from sync_map where workspace = $1 and service = $2`, [workspace, service]);
        // Links to remove stay until the remote delete succeeds, so a failure retries instead of re-importing.
        for (const l of [...p.links, ...links.filter((l) => p.removes.includes(l.remoteId))]) await link(l);
        await lock.query("commit");
      } catch (e) {
        await lock.query("rollback");
        throw e;
      }

      for (const u of p.updates) await a.update(u.remoteId, u.task, u.list);
      for (const id of p.removes) {
        await a.remove(id);
        await lock.query(`delete from sync_map where workspace = $1 and service = $2 and "remoteId" = $3`, [
          workspace,
          service,
          id,
        ]);
      }
      // Linked one by one: if a push fails halfway, what was created is still known next time.
      for (const c of p.creates)
        await link({ taskId: c.task.id, remoteId: await a.create(c.task, c.list), hash: fingerprint(c.task, svc.fields) });
      await a.done?.();
      return { pulled: p.edits.size + p.adds.length, pushed: p.creates.length + p.updates.length + p.removes.length };
    } finally {
      await lock.query(`select pg_advisory_unlock(hashtext($1))`, [`${workspace}:${service}`]);
    }
  } finally {
    lock.release();
  }
}
