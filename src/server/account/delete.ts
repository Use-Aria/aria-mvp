import "server-only";
// OWNER: 4.6
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 4.6 lands */

/**
 * Account deletion (master plan §1.16; web §7.6 order): `disconnectGoogle` + `disconnectCanvas`,
 * delete matching signups, delete the user (cascade). Idempotent. Web calls it directly; chat goes
 * through the `delete_account` executor → `account_purge` job (`via: "job"`). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";

/**
 * Hard-delete a user and everything they own.
 * @param userId user to delete
 * @param o which surface asked
 * @returns ok + whether the Google token was revoked at Google
 */
export async function deleteAccount(userId: string, o: { via: "web" | "chat" | "job" }): Promise<{ ok: true; googleRevoked: boolean }> {
  throw notImplemented("4.6");
}
