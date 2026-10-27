import { AppError } from "./errors.ts";

// Who a request comes from: the user of its session.
export type Viewer = {
  id: number;
  // Mousehole's level, L0–L5, and its role: user, moderator, admin or owner (design §6.1).
  level: number;
  role: string;
  frozen: boolean;
  muted: boolean;
  edit_revoked: boolean;
};

// What a route needs (design §6.2): members read everything; editing directly, reviewing and
// marking programs verified take L3; admins manage; the owner keeps the system settings.
export type Capability = "read" | "edit" | "admin" | "owner";

const EDIT_LEVEL = 3;

// The viewer, once they may do what `need` takes; otherwise the error api.md §1 lists for it.
export function checkPermission(viewer: Viewer | null, need: Capability) {
  if (!viewer) throw new AppError(401, "login_required", "请先登录");
  // Frozen accounts are no longer in the group, and count as guests.
  if (viewer.frozen) throw new AppError(403, "member_frozen", "账号已冻结，只能看预览");
  if (need === "read") return viewer;
  if (viewer.muted) throw new AppError(403, "muted", "禁言中，只能看、订阅和记报名");
  const admin = viewer.role === "admin" || viewer.role === "owner";
  if (need === "edit") {
    if (viewer.edit_revoked) throw new AppError(403, "edit_revoked", "你的修改权限已被管理员收回");
    if (viewer.level < EDIT_LEVEL && !admin) {
      throw new AppError(403, "level_required", `L${EDIT_LEVEL} 以上才能直接修改`);
    }
    return viewer;
  }
  if (need === "admin" && !admin) throw new AppError(403, "forbidden", "只有管理员能操作");
  if (need === "owner" && viewer.role !== "owner") {
    throw new AppError(403, "forbidden", "只有站长能操作");
  }
  return viewer;
}

export function can(viewer: Viewer | null, need: Capability) {
  try {
    checkPermission(viewer, need);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}
