import { expect, test } from "vitest";
import { checkPermission, type Capability, type Viewer } from "./access.ts";
import { AppError } from "./errors.ts";

const member: Viewer = {
  id: 1,
  level: 1,
  role: "user",
  frozen: false,
  muted: false,
  edit_revoked: false,
};

function refusal(viewer: Viewer | null, need: Capability) {
  try {
    checkPermission(viewer, need);
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return error.code;
  }
}

test("each kind of person may do what design §6.2 gives them, and no more", () => {
  const people: [string, Viewer | null, Record<Capability, string | null>][] = [
    [
      "guest",
      null,
      {
        read: "login_required",
        edit: "login_required",
        admin: "login_required",
        owner: "login_required",
      },
    ],
    [
      "frozen",
      { ...member, level: 4, role: "admin", frozen: true },
      {
        read: "member_frozen",
        edit: "member_frozen",
        admin: "member_frozen",
        owner: "member_frozen",
      },
    ],
    [
      "member",
      member,
      { read: null, edit: "level_required", admin: "forbidden", owner: "forbidden" },
    ],
    [
      "L3",
      { ...member, level: 3 },
      { read: null, edit: null, admin: "forbidden", owner: "forbidden" },
    ],
    [
      "muted L3",
      { ...member, level: 3, muted: true },
      { read: null, edit: "muted", admin: "muted", owner: "muted" },
    ],
    [
      "L3 whose editing was taken back",
      { ...member, level: 3, edit_revoked: true },
      { read: null, edit: "edit_revoked", admin: "forbidden", owner: "forbidden" },
    ],
    [
      "admin below L3",
      { ...member, role: "admin" },
      { read: null, edit: null, admin: null, owner: "forbidden" },
    ],
    ["owner", { ...member, role: "owner" }, { read: null, edit: null, admin: null, owner: null }],
  ];
  for (const [who, viewer, expected] of people) {
    const got = {
      read: refusal(viewer, "read"),
      edit: refusal(viewer, "edit"),
      admin: refusal(viewer, "admin"),
      owner: refusal(viewer, "owner"),
    };
    expect(got, who).toEqual(expected);
  }
});
