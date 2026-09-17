import { ENTITIES } from "@/lib/crud";
import { TEMPLATE_VARIABLES } from "@/lib/validation";
import type { Permission } from "@/lib/rbac";

export { TEMPLATE_VARIABLES };

/** Read/write capability pair for a generic config entity page. */
export function entityPermissionsFor(entity: string): { read: Permission; write: Permission } {
  const def = (ENTITIES as Record<string, { writePermission: Permission } | undefined>)[entity];
  const write = def?.writePermission ?? "content.write";
  const read = write.replace(".write", ".read") as Permission;
  return { read, write };
}
