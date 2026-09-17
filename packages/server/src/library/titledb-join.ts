/**
 * Joins the optional title database into content queries. titledb is applied when reading rather
 * than copied into other tables, so turning it off or refreshing it takes effect at once:
 *
 * - DLC whose base game was only guessed from its title ID uses the base ID titledb lists.
 * - Applications without NACP metadata take titledb's name and publisher.
 * - Content named only from its file name or ticket takes titledb's name.
 * - The latest known version comes from the base game's titledb entry.
 */
import type { ApplicationIdSource } from "@nslib/shared";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { applications, contentMetas, titledbTitles } from "../db/schema";

export const tdbTitle = alias(titledbTitles, "tdb_title");
export const tdbApp = alias(titledbTitles, "tdb_app");

export interface TitledbJoin {
  /** Join condition for `tdbTitle`; join it before anything that uses `applicationId`. */
  titleOn: SQL;
  /** Join condition for `applications`. */
  applicationOn: SQL;
  /** Join condition for `tdbApp`. */
  appOn: SQL;
  applicationId: SQL<string>;
  applicationIdSource: SQL<ApplicationIdSource>;
  displayName: SQL<string>;
  appName: SQL<string | null>;
  appPublisher: SQL<string | null>;
  latestKnownVersion: SQL<number | null>;
}

export function titledbJoin(enabled: boolean): TitledbJoin {
  const on = sql`${enabled ? 1 : 0} = 1`;
  const mapped = sql`(${contentMetas.applicationIdSource} = 'guess' and ${tdbTitle.applicationId} is not null)`;
  const applicationId = sql<string>`(case when ${mapped} then ${tdbTitle.applicationId} else ${contentMetas.applicationId} end)`;
  return {
    titleOn: and(eq(tdbTitle.titleId, contentMetas.titleId), on) as SQL,
    applicationOn: sql`${applications.applicationId} = ${applicationId}`,
    appOn: and(sql`${tdbApp.titleId} = ${applicationId}`, on) as SQL,
    applicationId,
    applicationIdSource: sql<ApplicationIdSource>`(case when ${mapped} then 'titledb' else ${contentMetas.applicationIdSource} end)`,
    displayName: sql<string>`(case when ${contentMetas.source} in ('filename', 'ticket') and ${tdbTitle.name} is not null then ${tdbTitle.name} else ${contentMetas.displayName} end)`,
    appName: sql<string | null>`coalesce(${applications.name}, ${tdbApp.name})`,
    appPublisher: sql<
      string | null
    >`(case when ${applications.name} is not null then ${applications.publisher} else coalesce(${applications.publisher}, ${tdbApp.publisher}) end)`,
    latestKnownVersion: sql<
      number | null
    >`coalesce(${applications.latestKnownVersion}, ${tdbApp.latestVersion})`,
  };
}
