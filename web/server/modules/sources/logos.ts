import { sql } from "kysely";

// The address of the emblem of the school `school` refers to, or null without one. When it last
// changed is in the address, so browsers keep it until it changes.
export function logoOf(school: string) {
  return sql<
    string | null
  >`(SELECT '/api/v1/schools/' || school_id || '/logo?v=' || floor(extract(epoch FROM updated_at) * 1000)::bigint FROM school_logos WHERE school_id = ${sql.ref(school)})`;
}
