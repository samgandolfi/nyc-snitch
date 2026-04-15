"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { getDobComplaintCategoryLabel } from "@/lib/dob-complaint-categories";

type SafetyLevel = "Green" | "Yellow" | "Red";

/** DOB Complaints (vztk-gaf7) — same address match as safety-score count. */
type DobComplaintRow = {
  complaint_number?: string;
  status?: string;
  complaint_category?: string;
  date_entered?: string;
  inspection_date?: string;
  disposition_code?: string;
  unit?: string;
};

type HpdViolationRow = {
  violationid?: string;
  registrationid?: string | number;
  housenumber?: string;
  streetname?: string;
  class?: string;
  novdescription?: string;
  currentstatus?: string;
  inspectiondate?: string;
};

/** HPD Registration Contacts (feu5-w2e2), joined via `registrationid` on violations or MDR. */
type HpdRegistrationContactRow = {
  registrationid?: string | number;
  type?: string;
  corporationname?: string;
  firstname?: string;
  middleinitial?: string;
  lastname?: string;
  contactdescription?: string;
  title?: string;
  businesshousenumber?: string;
  businessstreetname?: string;
  businessapartment?: string;
  businesscity?: string;
  businessstate?: string;
  businesszip?: string;
  /** Not in current Open Data schema; kept for forward compatibility / optional columns. */
  businessphone?: string;
  phone?: string;
  registrationcontactid?: string | number;
};

type Heat311Row = {
  unique_key?: string;
  created_date?: string;
  descriptor?: string;
  complaint_type?: string;
};

/** 311 SRs routed to HPD at this address (dedupe on `unique_key`). */
type Tenant311Row = {
  unique_key?: string;
  created_date?: string;
  complaint_type?: string;
  descriptor?: string;
  status?: string;
};

/** NYC Open Data stores DOHMH “Active Rat Signs” as result value `Rat Activity`. */
type RodentInspectionRow = {
  house_number?: string;
  street_name?: string;
  inspection_date?: string;
  result?: string;
  inspection_type?: string;
  borough?: string;
};

const APP_TOKEN = "x3IpcsPIypsdi03KGFDG8awmW";
const RODENT_INSPECTION_RESOURCE =
  "https://data.cityofnewyork.us/resource/p937-wjvj.json";
const THREE_ONE_ONE_RESOURCE =
  "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const HPD_VIOLATIONS_RESOURCE =
  "https://data.cityofnewyork.us/resource/wvxf-dwi5.json";
const DOB_COMPLAINTS_RESOURCE =
  "https://data.cityofnewyork.us/resource/vztk-gaf7.json";
const HPD_REGISTRATION_CONTACTS_RESOURCE =
  "https://data.cityofnewyork.us/resource/feu5-w2e2.json";
/** Multiple Dwelling Registrations (tesw-yqqr) — resolve `registrationid` by address when violations are empty. */
const HPD_MULTIPLE_DWELLING_REGISTRATIONS_RESOURCE =
  "https://data.cityofnewyork.us/resource/tesw-yqqr.json";

type ResultsTabId = "overview" | "history" | "rent" | "owner";

/** Rent Check — neighborhood baseline averages (monthly). */
type RentBedroomOption = "studio" | "1br" | "2br" | "3brPlus";

const RENT_BASELINES_BY_ZIP: Record<string, Record<RentBedroomOption, number>> = {
  "11238": { studio: 2700, "1br": 3300, "2br": 4200, "3brPlus": 5200 },
  "10038": { studio: 3800, "1br": 4500, "2br": 5800, "3brPlus": 7500 },
};

const RENT_BASELINE_FALLBACK: Record<RentBedroomOption, number> = {
  studio: 2900,
  "1br": 3600,
  "2br": 4600,
  "3brPlus": 5800,
};

function getNeighborhoodRentAverage(zip5: string, bedroom: RentBedroomOption): number {
  const row = RENT_BASELINES_BY_ZIP[zip5];
  if (row) return row[bedroom];
  return RENT_BASELINE_FALLBACK[bedroom];
}

function parseMonthlyRentInput(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function rentDealMeterMarkerPercent(percentDiffVsAverage: number): number {
  /** Map % above/below average to bar position: left = paying less (good), right = paying more. */
  const clamped = Math.max(-60, Math.min(60, percentDiffVsAverage));
  return Math.max(4, Math.min(96, 50 + clamped * 0.75));
}

function isHpdViolationOpen(status?: string): boolean {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return false;
  if (/\bopen\b|\bpending\b|\bactive\b|\bnot\s+certified\b|\bfail\b/.test(s)) return true;
  if (
    /\bclosed\b|\bcertified\b|\bresolved\b|\bcured\b|\bdismiss|\bviolation\s+closed\b/.test(s)
  ) {
    return false;
  }
  return !/\bclose|\bcertif|\bresolve|\bdismiss|\bcure\b/.test(s);
}

function registrationContactRowScore(row: HpdRegistrationContactRow): number {
  let s = 0;
  if (row.corporationname?.trim()) s += 4;
  if (row.firstname?.trim() || row.lastname?.trim()) s += 2;
  if (row.businessstreetname?.trim()) s += 1;
  return s;
}

function pickBestRegistrationContactRow(
  rows: HpdRegistrationContactRow[],
): HpdRegistrationContactRow | null {
  if (!rows.length) return null;
  return rows.reduce((best, cur) =>
    registrationContactRowScore(cur) > registrationContactRowScore(best) ? cur : best,
  );
}

/** Registered owner rows: CorporateOwner, IndividualOwner, JointOwner. */
function pickOwnerContactRow(contacts: HpdRegistrationContactRow[]): HpdRegistrationContactRow | null {
  const order = ["CorporateOwner", "IndividualOwner", "JointOwner"] as const;
  for (const t of order) {
    const rows = contacts.filter((c) => c.type === t);
    const best = pickBestRegistrationContactRow(rows);
    if (best) return best;
  }
  return null;
}

/** Registered managing agent: HPD uses `Agent`; `SiteManager` is a fallback. */
function pickManagingAgentContactRow(
  contacts: HpdRegistrationContactRow[],
): HpdRegistrationContactRow | null {
  const agents = contacts.filter((c) => c.type === "Agent");
  const fromAgents = pickBestRegistrationContactRow(agents);
  if (fromAgents) return fromAgents;
  const site = contacts.filter((c) => c.type === "SiteManager");
  return pickBestRegistrationContactRow(site);
}

function pickHeadOfficerContactRow(
  contacts: HpdRegistrationContactRow[],
): HpdRegistrationContactRow | null {
  const rows = contacts.filter((c) => c.type === "HeadOfficer");
  return pickBestRegistrationContactRow(rows);
}

function normalizeRegistrationTitleKey(title?: string): "head_officer" | "managing_agent" | null {
  const t = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[,.\s]+$/g, "")
    .trim();
  if (t === "head officer") return "head_officer";
  if (t === "managing agent") return "managing_agent";
  return null;
}

function isSameRegistrationContactRow(
  a: HpdRegistrationContactRow | null,
  b: HpdRegistrationContactRow | null,
): boolean {
  if (!a || !b) return false;
  const idA = a.registrationcontactid;
  const idB = b.registrationcontactid;
  if (idA != null && idB != null && String(idA) === String(idB)) return true;
  return (
    String(a.registrationid ?? "") === String(b.registrationid ?? "") &&
    formatPersonNameParts(a).toUpperCase() === formatPersonNameParts(b).toUpperCase() &&
    (a.type ?? "") === (b.type ?? "")
  );
}

function sqlEscapeSoqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Prefer head officer for portfolio stats; else managing agent. Requires first + last name. */
function pickPortfolioNameSource(
  contacts: HpdRegistrationContactRow[],
): { row: HpdRegistrationContactRow; role: "head_officer" | "managing_agent" } | null {
  const ho = pickHeadOfficerContactRow(contacts);
  if (ho?.firstname?.trim() && ho?.lastname?.trim()) {
    return { row: ho, role: "head_officer" };
  }
  const ma = pickManagingAgentContactRow(contacts);
  if (ma?.firstname?.trim() && ma?.lastname?.trim()) {
    return { row: ma, role: "managing_agent" };
  }
  return null;
}

/**
 * Names are matched on Registration Contacts (feu5-w2e2); unique `buildingid`s come from Multiple
 * Dwelling Registrations (tesw-yqqr) via `registrationid`. Returns count minus this search’s
 * building(s).
 */
async function fetchPortfolioOtherBuildingsCount(
  firstName: string,
  lastName: string,
  currentMdrRows: Array<{ buildingid?: string | number }>,
  headers: HeadersInit,
): Promise<number> {
  const fnU = firstName.trim().toUpperCase();
  const lnU = lastName.trim().toUpperCase();
  if (!fnU || !lnU) return 0;

  const fnEsc = sqlEscapeSoqlString(fnU);
  const lnEsc = sqlEscapeSoqlString(lnU);
  const contactWhere = `upper(trim(firstname))='${fnEsc}' AND upper(trim(lastname))='${lnEsc}'`;

  const regParams = new URLSearchParams({
    $select: "registrationid",
    $where: contactWhere,
    $group: "registrationid",
    $limit: "50000",
  });

  const regRes = await fetch(
    `${HPD_REGISTRATION_CONTACTS_RESOURCE}?${regParams.toString()}`,
    { headers, cache: "no-store" },
  );
  if (!regRes.ok) throw new Error("Portfolio registration lookup failed.");
  const regRows = (await regRes.json()) as Array<{ registrationid?: string | number }>;
  const regIds = [
    ...new Set(
      regRows
        .map((r) => r.registrationid)
        .filter((id) => id != null && String(id).trim() !== "")
        .map((id) => Number(String(id).trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const buildingIds = new Set<string>();
  const chunkSize = 40;
  for (let i = 0; i < regIds.length; i += chunkSize) {
    const chunk = regIds.slice(i, i + chunkSize);
    const where = `registrationid in (${chunk.join(",")})`;
    const mdrParams = new URLSearchParams({
      $select: "buildingid",
      $where: where,
      $limit: "50000",
    });
    const mdrRes = await fetch(
      `${HPD_MULTIPLE_DWELLING_REGISTRATIONS_RESOURCE}?${mdrParams.toString()}`,
      { headers, cache: "no-store" },
    );
    if (!mdrRes.ok) continue;
    const mRows = (await mdrRes.json()) as Array<{ buildingid?: string | number }>;
    for (const row of mRows) {
      const bid = row.buildingid != null ? String(row.buildingid).trim() : "";
      if (bid) buildingIds.add(bid);
    }
  }

  const currentBuildingIds = new Set(
    currentMdrRows
      .map((r) => (r.buildingid != null ? String(r.buildingid).trim() : ""))
      .filter(Boolean),
  );

  let overlap = 0;
  for (const bid of currentBuildingIds) {
    if (buildingIds.has(bid)) overlap += 1;
  }

  return Math.max(0, buildingIds.size - overlap);
}

const ADDRESS_NETWORK_HUB_THRESHOLD = 10;

function hasMinimumBusinessStreetAddress(row: HpdRegistrationContactRow | null): boolean {
  if (!row) return false;
  return Boolean(row.businesshousenumber?.trim() && row.businessstreetname?.trim());
}

/** SoQL filter for the same normalized business address lines on Registration Contacts (feu5-w2e2). */
function buildBusinessAddressWhereClause(row: HpdRegistrationContactRow): string | null {
  if (!hasMinimumBusinessStreetAddress(row)) return null;
  const hn = row.businesshousenumber!.trim().toUpperCase();
  const sn = row.businessstreetname!.trim().toUpperCase();
  const parts: string[] = [
    `upper(trim(businesshousenumber))='${sqlEscapeSoqlString(hn)}'`,
    `upper(trim(businessstreetname))='${sqlEscapeSoqlString(sn)}'`,
  ];
  const apt = row.businessapartment?.trim();
  if (apt) {
    parts.push(`upper(trim(businessapartment))='${sqlEscapeSoqlString(apt.toUpperCase())}'`);
  } else {
    parts.push(`(businessapartment is null or trim(businessapartment)='')`);
  }
  const city = row.businesscity?.trim();
  if (city) parts.push(`upper(trim(businesscity))='${sqlEscapeSoqlString(city.toUpperCase())}'`);
  const st = row.businessstate?.trim();
  if (st) parts.push(`upper(trim(businessstate))='${sqlEscapeSoqlString(st.toUpperCase())}'`);
  const zipRaw = row.businesszip?.trim();
  if (zipRaw && !isZipRedacted(zipRaw)) {
    parts.push(`trim(businesszip)='${sqlEscapeSoqlString(zipRaw)}'`);
  }
  return parts.join(" AND ");
}

/**
 * "Secret portfolio": contacts sharing the same business address → MDR `buildingid`s (tesw-yqqr),
 * minus this search’s building(s).
 */
async function fetchAddressNetworkOtherBuildingsCount(
  addressSourceRow: HpdRegistrationContactRow,
  currentMdrRows: Array<{ buildingid?: string | number }>,
  headers: HeadersInit,
): Promise<number> {
  const contactWhere = buildBusinessAddressWhereClause(addressSourceRow);
  if (!contactWhere) return 0;

  const regParams = new URLSearchParams({
    $select: "registrationid",
    $where: contactWhere,
    $group: "registrationid",
    $limit: "50000",
  });

  const regRes = await fetch(
    `${HPD_REGISTRATION_CONTACTS_RESOURCE}?${regParams.toString()}`,
    { headers, cache: "no-store" },
  );
  if (!regRes.ok) throw new Error("Address network registration lookup failed.");
  const regRows = (await regRes.json()) as Array<{ registrationid?: string | number }>;
  const regIds = [
    ...new Set(
      regRows
        .map((r) => r.registrationid)
        .filter((id) => id != null && String(id).trim() !== "")
        .map((id) => Number(String(id).trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];

  const buildingIds = new Set<string>();
  const chunkSize = 40;
  for (let i = 0; i < regIds.length; i += chunkSize) {
    const chunk = regIds.slice(i, i + chunkSize);
    const where = `registrationid in (${chunk.join(",")})`;
    const mdrParams = new URLSearchParams({
      $select: "buildingid",
      $where: where,
      $limit: "50000",
    });
    const mdrRes = await fetch(
      `${HPD_MULTIPLE_DWELLING_REGISTRATIONS_RESOURCE}?${mdrParams.toString()}`,
      { headers, cache: "no-store" },
    );
    if (!mdrRes.ok) continue;
    const mRows = (await mdrRes.json()) as Array<{ buildingid?: string | number }>;
    for (const row of mRows) {
      const bid = row.buildingid != null ? String(row.buildingid).trim() : "";
      if (bid) buildingIds.add(bid);
    }
  }

  const currentBuildingIds = new Set(
    currentMdrRows
      .map((r) => (r.buildingid != null ? String(r.buildingid).trim() : ""))
      .filter(Boolean),
  );

  let overlap = 0;
  for (const bid of currentBuildingIds) {
    if (buildingIds.has(bid)) overlap += 1;
  }

  return Math.max(0, buildingIds.size - overlap);
}

/** Head officer / managing agent row with a usable business address (for address-network search). */
function pickRegistrationRowWithBusinessAddress(
  contacts: HpdRegistrationContactRow[],
): HpdRegistrationContactRow | null {
  const named = pickPortfolioNameSource(contacts);
  if (named && hasMinimumBusinessStreetAddress(named.row)) return named.row;
  const ho = pickHeadOfficerContactRow(contacts);
  if (hasMinimumBusinessStreetAddress(ho)) return ho;
  const ma = pickManagingAgentContactRow(contacts);
  if (hasMinimumBusinessStreetAddress(ma)) return ma;
  return null;
}

async function fetchGroupedRegistrationIdsForWhere(
  where: string,
  headers: HeadersInit,
): Promise<number[]> {
  const regParams = new URLSearchParams({
    $select: "registrationid",
    $where: where,
    $group: "registrationid",
    $limit: "50000",
  });
  const regRes = await fetch(
    `${HPD_REGISTRATION_CONTACTS_RESOURCE}?${regParams.toString()}`,
    { headers, cache: "no-store" },
  );
  if (!regRes.ok) return [];
  const regRows = (await regRes.json()) as Array<{ registrationid?: string | number }>;
  return [
    ...new Set(
      regRows
        .map((r) => r.registrationid)
        .filter((id) => id != null && String(id).trim() !== "")
        .map((id) => Number(String(id).trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ];
}

/** Union of registration IDs from portfolio-by-name and portfolio-by-business-address (feu5-w2e2). */
async function collectPortfolioSearchRegistrationIds(
  contacts: HpdRegistrationContactRow[],
  headers: HeadersInit,
): Promise<number[]> {
  const union = new Set<number>();
  const src = pickPortfolioNameSource(contacts);
  if (src?.row.firstname?.trim() && src.row.lastname?.trim()) {
    const fnU = src.row.firstname.trim().toUpperCase();
    const lnU = src.row.lastname.trim().toUpperCase();
    const where = `upper(trim(firstname))='${sqlEscapeSoqlString(fnU)}' AND upper(trim(lastname))='${sqlEscapeSoqlString(lnU)}'`;
    for (const id of await fetchGroupedRegistrationIdsForWhere(where, headers)) union.add(id);
  }
  const addrRow = pickRegistrationRowWithBusinessAddress(contacts);
  const addrWhere = addrRow ? buildBusinessAddressWhereClause(addrRow) : null;
  if (addrWhere) {
    for (const id of await fetchGroupedRegistrationIdsForWhere(addrWhere, headers)) union.add(id);
  }
  return [...union];
}

async function fetchDistinctBuildingCountForRegistrationIds(
  regIds: number[],
  headers: HeadersInit,
): Promise<number> {
  const buildingIds = new Set<string>();
  const chunkSize = 40;
  const capped = regIds.slice(0, 2000);
  for (let i = 0; i < capped.length; i += chunkSize) {
    const chunk = capped.slice(i, i + chunkSize);
    const where = `registrationid in (${chunk.join(",")})`;
    const mdrParams = new URLSearchParams({
      $select: "buildingid",
      $where: where,
      $limit: "50000",
    });
    const mdrRes = await fetch(
      `${HPD_MULTIPLE_DWELLING_REGISTRATIONS_RESOURCE}?${mdrParams.toString()}`,
      { headers, cache: "no-store" },
    );
    if (!mdrRes.ok) continue;
    const mRows = (await mdrRes.json()) as Array<{ buildingid?: string | number }>;
    for (const row of mRows) {
      const bid = row.buildingid != null ? String(row.buildingid).trim() : "";
      if (bid) buildingIds.add(bid);
    }
  }
  return buildingIds.size;
}

async function fetchViolationsForPortfolioRegistrationIds(
  regIds: number[],
  headers: HeadersInit,
): Promise<Array<{ violationid?: string; novdescription?: string; class?: string }>> {
  const out: Array<{ violationid?: string; novdescription?: string; class?: string }> = [];
  const seenViolation = new Set<string>();
  const chunkSize = 25;
  const capped = regIds.slice(0, 800);
  for (let i = 0; i < capped.length; i += chunkSize) {
    const chunk = capped.slice(i, i + chunkSize);
    const params = new URLSearchParams({
      $select: "violationid,novdescription,class",
      $where: `registrationid in (${chunk.join(",")})`,
      $limit: "50000",
    });
    const res = await fetch(`${HPD_VIOLATIONS_RESOURCE}?${params.toString()}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) continue;
    const rows = (await res.json()) as Array<{
      violationid?: string;
      novdescription?: string;
      class?: string;
    }>;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const vid = String(row.violationid ?? "").trim();
      if (vid) {
        if (seenViolation.has(vid)) continue;
        seenViolation.add(vid);
      }
      out.push(row);
    }
  }
  return out;
}

/** Human-readable bucket for portfolio-wide violation hotspot (NOV text + class). */
function classifyPortfolioViolationHotspot(nov?: string, klass?: string): string {
  const u = (nov ?? "").toUpperCase();
  if (/\bHEAT|HOT\s*WATER|BOILER|RADIATOR|HVAC|STEAM\b/.test(u)) return "Heat/Hot Water";
  if (/\bMOUSE|MICE|RAT|RODENT|ROACH|PEST|BED\s*BUG|INSECT|VERMIN\b/.test(u)) return "Mice";
  if (/\bMOLD|DAMP|MILDEW\b/.test(u)) return "Mold";
  if (/\bELEVATOR|ELEV\b/.test(u)) return "Elevator issues";
  if (/\bWINDOW\b/.test(u)) return "Windows";
  if (/\bDOOR|HINGE|SELF-?CLOSING\b/.test(u)) return "Doors";
  if (/\bPLUMB|LEAK|PIPE|WATER\s*SEEP\b/.test(u)) return "Plumbing";
  if (/\bELECT|WIRING\b/.test(u)) return "Electrical";
  if (/\bLEAD|LBP\b/.test(u)) return "Lead paint";
  if (/\bGARBAGE|TRASH|REFUSE\b/.test(u)) return "Garbage & refuse";
  if (/\bPAINT|PEEL\b/.test(u)) return "Paint & peeling";
  const c = (klass ?? "").trim().toUpperCase();
  if (c === "A") return "Class A (immediate hazard) violations";
  if (c === "B") return "Class B violations";
  if (c === "C") return "Class C violations";
  return "General housing maintenance";
}

async function fetchPortfolioViolationTrends(
  contacts: HpdRegistrationContactRow[],
  headers: HeadersInit,
): Promise<{ avgPerBuilding: number; hotspotLabel: string | null } | null> {
  const regIds = await collectPortfolioSearchRegistrationIds(contacts, headers);
  if (regIds.length === 0) return null;
  const buildingCount = await fetchDistinctBuildingCountForRegistrationIds(regIds, headers);
  if (buildingCount === 0) return null;
  const violations = await fetchViolationsForPortfolioRegistrationIds(regIds, headers);
  const total = violations.length;
  const avgRaw = total / buildingCount;
  const avgPerBuilding = Math.round(avgRaw * 10) / 10;
  if (total === 0) {
    return { avgPerBuilding, hotspotLabel: null };
  }
  const tallies = new Map<string, number>();
  for (const v of violations) {
    const label = classifyPortfolioViolationHotspot(v.novdescription, v.class);
    tallies.set(label, (tallies.get(label) ?? 0) + 1);
  }
  let hotspotLabel = "General housing maintenance";
  let max = 0;
  for (const [label, n] of tallies) {
    if (n > max) {
      max = n;
      hotspotLabel = label;
    }
  }
  return { avgPerBuilding, hotspotLabel };
}

function RegistrationContactPersonValue({ row }: { row: HpdRegistrationContactRow | null }) {
  if (!row) return <>—</>;
  const titleRaw = row.title?.trim();
  const name = formatPersonNameParts(row);
  const tKey = normalizeRegistrationTitleKey(titleRaw);
  const isHeadOfficerRole = tKey === "head_officer" || row.type === "HeadOfficer";
  const isManagingAgentRole = tKey === "managing_agent";
  const showRichHeadOrManaging = isHeadOfficerRole || isManagingAgentRole;

  if (showRichHeadOrManaging) {
    const friendlyLabel =
      tKey === "head_officer" ? "Head Officer" : tKey === "managing_agent" ? "Managing Agent" : null;
    let displayTitle = friendlyLabel ?? "";
    if (!displayTitle && isHeadOfficerRole) displayTitle = "Head Officer";
    if (!displayTitle && isManagingAgentRole) displayTitle = "Managing Agent";
    if (!displayTitle && titleRaw) displayTitle = titleRaw.replace(/[,.\s]+$/g, "").trim();

    return (
      <div className="space-y-1.5">
        {displayTitle ? (
          <p className="text-base font-medium leading-snug text-[#1A1A1A]">{displayTitle}</p>
        ) : null}
        {isHeadOfficerRole ? (
          <p className="text-xs leading-relaxed text-stone-500">
            High-level officer of the owning entity.
          </p>
        ) : null}
        {isManagingAgentRole ? (
          <p className="text-xs leading-relaxed text-stone-500">
            Responsible for day-to-day operations and repairs.
          </p>
        ) : null}
        {name ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-base font-medium leading-snug text-[#1A1A1A]">{name}</span>
          </div>
        ) : null}
        {!displayTitle && !name ? <span>—</span> : null}
      </div>
    );
  }

  return (
    <span className="text-base font-medium leading-snug text-[#1A1A1A]">
      {formatRegistrationContactPerson(row)}
    </span>
  );
}

function formatPersonNameParts(row: HpdRegistrationContactRow): string {
  return [row.firstname, row.middleinitial, row.lastname]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter(Boolean)
    .join(" ");
}

function formatRegistrationCompanyName(row: HpdRegistrationContactRow | null): string {
  if (!row) return "—";
  const corp = row.corporationname?.trim();
  if (corp) return corp;
  const person = formatPersonNameParts(row);
  return person || "—";
}

function formatRegistrationContactPerson(row: HpdRegistrationContactRow | null): string {
  if (!row) return "—";
  const title = row.title?.trim();
  const person = formatPersonNameParts(row);
  if (title && person) return `${title} — ${person}`;
  if (person) return person;
  if (title) return title;
  return "—";
}

/** Hide Company name when it duplicates the contact person (common for individual owners / agents). */
function shouldHideRegistrationCompanyName(row: HpdRegistrationContactRow | null): boolean {
  if (!row) return false;
  const company = formatRegistrationCompanyName(row).trim();
  if (!company || company === "—") return false;
  if (company === formatRegistrationContactPerson(row).trim()) return true;
  const personOnly = formatPersonNameParts(row).trim();
  if (personOnly && company === personOnly) return true;
  return false;
}

function isZipRedacted(zip?: string): boolean {
  const z = zip?.trim() ?? "";
  return z.length > 0 && /^X+$/i.test(z);
}

function formatRegistrationBusinessAddress(row: HpdRegistrationContactRow | null): string {
  if (!row) return "—";
  const street = [row.businesshousenumber, row.businessstreetname]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter(Boolean)
    .join(" ");
  if (!street) return "—";
  const apt = row.businessapartment?.trim();
  const line1 = apt ? `${street}, ${apt}` : street;
  const city = row.businesscity?.trim();
  const st = row.businessstate?.trim();
  const zipRaw = row.businesszip?.trim();
  const zip = isZipRedacted(zipRaw) ? null : zipRaw;
  const locality = [city, [st, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return locality ? `${line1}, ${locality}` : line1;
}

/** NYC Open Data may add phone fields later; also checks optional keys on the row object. */
function extractRegistrationPhoneDigits(row: HpdRegistrationContactRow): string | null {
  const ext = row as HpdRegistrationContactRow & Record<string, string | undefined>;
  const keys = [
    "businessphone",
    "businessphonenumber",
    "phone",
    "telephone",
    "primaryphone",
  ] as const;
  for (const key of keys) {
    const raw = ext[key]?.trim();
    if (!raw) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10) {
      if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
      return digits.slice(-10);
    }
  }
  return null;
}

/** Buckets apply to DOB complaint count in the trailing 24 months only. */
function getSafetyLevel(complaintCount: number): SafetyLevel {
  if (complaintCount <= 2) return "Green";
  if (complaintCount <= 5) return "Yellow";
  return "Red";
}

function getSafetyLabel(level: SafetyLevel): string {
  if (level === "Green") return "Low complaint activity";
  if (level === "Yellow") return "Moderate complaint activity";
  return "High complaint activity";
}

/** Parses NYC Open Data date strings: ISO, `MM/DD/YYYY` (DOB), or leading `YYYY-MM-DD`. */
function parseDateForSort(value?: string): Date | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  let d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (mdy) {
    d = new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (ymd) {
    d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function formatEnteredDate(value?: string): string {
  const d = parseDateForSort(value);
  if (!d) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function isWithinLast30Days(value?: string): boolean {
  const d = parseDateForSort(value);
  if (!d) return false;
  const now = new Date();
  if (d.getTime() > now.getTime()) return false;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  return d.getTime() >= cutoff.getTime();
}

function RecentBadge() {
  return (
    <span className="inline-block shrink-0 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.14em] text-blue-700">
      RECENT
    </span>
  );
}

/** Newest first: primary `date_entered`, tie-break `inspection_date`, then complaint #. */
function compareDobComplaintsNewestFirst(a: DobComplaintRow, b: DobComplaintRow): number {
  const tb = parseDateForSort(b.date_entered)?.getTime() ?? 0;
  const ta = parseDateForSort(a.date_entered)?.getTime() ?? 0;
  if (tb !== ta) return tb - ta;
  const ib = parseDateForSort(b.inspection_date)?.getTime() ?? 0;
  const ia = parseDateForSort(a.inspection_date)?.getTime() ?? 0;
  if (ib !== ia) return ib - ia;
  return (b.complaint_number ?? "").localeCompare(a.complaint_number ?? "", "en");
}

function isWithinLastFiveYears(value?: string): boolean {
  const parsedDate = parseDateForSort(value);
  if (!parsedDate) return false;
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 5);
  return parsedDate >= cutoffDate;
}

function isNewComplaint(value?: string): boolean {
  if (!value) return false;
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return false;
  const year = parsedDate.getFullYear();
  return year === 2025 || year === 2026;
}

function dedupe311ByUniqueKey(rows: Tenant311Row[]): Tenant311Row[] {
  const seen = new Map<string, Tenant311Row>();
  for (const row of rows) {
    const key = row.unique_key?.trim();
    if (key) {
      if (!seen.has(key)) seen.set(key, row);
      continue;
    }
    const fallback = `${row.created_date ?? ""}|${row.descriptor ?? ""}|${row.complaint_type ?? ""}`;
    if (!seen.has(fallback)) seen.set(fallback, row);
  }
  return Array.from(seen.values()).sort((a, b) => {
    const tb = parseDateForSort(b.created_date)?.getTime() ?? 0;
    const ta = parseDateForSort(a.created_date)?.getTime() ?? 0;
    return tb - ta;
  });
}

function getHeatComplaintSeverity(count: number): {
  label: string;
  className: string;
} | null {
  if (count > 50) {
    return {
      label: "CRITICAL ISSUE",
      className: "border border-red-800 bg-red-100 text-red-950",
    };
  }
  if (count >= 10 && count <= 50) {
    return {
      label: "RECURRING PROBLEM",
      className: "border border-amber-700 bg-amber-100 text-amber-950",
    };
  }
  return null;
}

function getViolationEmoji(nov?: string, klass?: string): string {
  const u = (nov ?? "").toUpperCase();
  if (/\bBED\s*BUG|BEDBUG|CIMEX\b/.test(u)) return "🪳";
  if (/\bROACH|PEST\b/.test(u)) return "🪳";
  if (/\bMOLD|MOULD|DAMP|DAMPNESS\b/.test(u)) return "🦠";
  if (/\bLEAD|LBP\b/.test(u)) return "🎨";
  if (/\bHEAT|HOT\s*WATER|BOILER|HVAC|RADIATOR\b/.test(u)) return "🔥";
  if (/\bPLUMB|PIPE|LEAK\b/.test(u)) return "🛠️";
  if (/\bELEV|ELEVATOR\b/.test(u)) return "🛗";
  if (/\bWINDOW|FRAME\b/.test(u)) return "🪟";
  if (/\bDOOR|HINGE|SELF-?CLOSING\b/.test(u)) return "🚪";
  if (/\bELECT|WIRING\b/.test(u)) return "⚡";
  if (/\bGARBAGE|TRASH|REFUSE\b/.test(u)) return "🗑️";
  if (/\bPAINT|PEEL\b/.test(u)) return "🖌️";
  const c = (klass ?? "").trim().toUpperCase();
  if (c === "A") return "🔴";
  if (c === "B") return "🟠";
  if (c === "C") return "🟡";
  return "⚖️";
}

/** Full street first, then common NYC abbreviations (e.g. AVENUE → AVE). */
function buildStreetNameVariants(upperStreet: string): string[] {
  const base = upperStreet.trim();
  const out: string[] = [];
  if (base) out.push(base);
  const abbrevs: [RegExp, string][] = [
    [/\bAVENUE\b/g, "AVE"],
    [/\bSTREET\b/g, "ST"],
    [/\bBOULEVARD\b/g, "BLVD"],
    [/\bPLACE\b/g, "PL"],
    [/\bROAD\b/g, "RD"],
    [/\bDRIVE\b/g, "DR"],
    [/\bLANE\b/g, "LN"],
    [/\bTERRACE\b/g, "TER"],
    [/\bCOURT\b/g, "CT"],
    [/\bEXPRESSWAY\b/g, "EXPY"],
  ];
  for (const [re, rep] of abbrevs) {
    const next = base.replace(re, rep);
    if (next !== base && !out.includes(next)) out.push(next);
  }
  /** If user typed an abbreviation, also try the long form (e.g. FRANKLIN AVE → FRANKLIN AVENUE). */
  const expanders: [RegExp, string][] = [
    [/\bAVE\b/g, "AVENUE"],
    [/\bST\b/g, "STREET"],
    [/\bBLVD\b/g, "BOULEVARD"],
    [/\bPL\b/g, "PLACE"],
    [/\bRD\b/g, "ROAD"],
    [/\bDR\b/g, "DRIVE"],
    [/\bLN\b/g, "LANE"],
    [/\bTER\b/g, "TERRACE"],
    [/\bCT\b/g, "COURT"],
    [/\bEXPY\b/g, "EXPRESSWAY"],
  ];
  for (const [re, rep] of expanders) {
    const next = base.replace(re, rep);
    if (next !== base && !out.includes(next)) out.push(next);
  }
  return out;
}

function sqlUpperStreetIn(field: string, variantsUpper: string[]): string {
  const parts = variantsUpper.map((v) => {
    const esc = v.replace(/'/g, "''");
    return `upper(${field})='${esc}'`;
  });
  return `(${parts.join(" OR ")})`;
}

function get311Emoji(complaintType?: string, descriptor?: string): string {
  const t = `${complaintType ?? ""} ${descriptor ?? ""}`.toUpperCase();
  if (t.includes("HEAT") || t.includes("HOT WATER")) return "🔥";
  if (t.includes("BED")) return "🪳";
  if (t.includes("PLUMB") || t.includes("LEAK") || t.includes("WATER")) return "🛠️";
  if (t.includes("MOLD") || t.includes("UNSANITARY")) return "🦠";
  if (t.includes("PAINT") || t.includes("PEEL")) return "🖌️";
  if (t.includes("ELEV")) return "🛗";
  if (t.includes("NOISE")) return "🔊";
  if (t.includes("DOOR") || t.includes("WINDOW")) return "🪟";
  return "📣";
}

export default function Home() {
  const [houseNumber, setHouseNumber] = useState("");
  const [streetName, setStreetName] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [resultsTab, setResultsTab] = useState<ResultsTabId>("overview");
  /** DOB complaints in the last 24 months — drives safety score + Legal summary DOB number. */
  const [complaintCount, setComplaintCount] = useState<number | null>(null);
  /** All-time DOB complaint count at this address (for list vs. total messaging). */
  const [dobComplaintsTotalOnFile, setDobComplaintsTotalOnFile] = useState<number | null>(null);
  const [dobComplaints, setDobComplaints] = useState<DobComplaintRow[]>([]);
  const [hpdViolations, setHpdViolations] = useState<HpdViolationRow[]>([]);
  const [activeRatSignInspections, setActiveRatSignInspections] = useState<
    RodentInspectionRow[]
  >([]);
  const [heatHotWater311Last12Months, setHeatHotWater311Last12Months] = useState<
    number | null
  >(null);
  const [heat311Rows, setHeat311Rows] = useState<Heat311Row[]>([]);
  const [tenant311Rows, setTenant311Rows] = useState<Tenant311Row[]>([]);
  const [tenant311Count, setTenant311Count] = useState<number | null>(null);
  const [hpdRegistrationContacts, setHpdRegistrationContacts] = useState<HpdRegistrationContactRow[]>(
    [],
  );
  /** Distinct MDR `buildingid`s tied to the head officer or managing agent (minus this building). */
  const [portfolioOtherBuildingsCount, setPortfolioOtherBuildingsCount] = useState<number | null>(
    null,
  );
  /** Current search address — MDR `buildingid`s from tesw-yqqr (for portfolio overlap). */
  const [portfolioAnchorBuildingIds, setPortfolioAnchorBuildingIds] = useState<string[]>([]);
  /** Other buildings sharing the portfolio source registered business address (Secret Portfolio). */
  const [addressNetworkOtherBuildingsCount, setAddressNetworkOtherBuildingsCount] = useState<
    number | null
  >(null);
  const [negotiationStrategyModalOpen, setNegotiationStrategyModalOpen] = useState(false);
  /** Systemic violation trend across portfolio (name + address search) — HPD violations API. */
  const [portfolioTrends, setPortfolioTrends] = useState<{
    avgPerBuilding: number;
    hotspotLabel: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [rentCheckMonthly, setRentCheckMonthly] = useState("");
  const [rentCheckBedroom, setRentCheckBedroom] = useState<RentBedroomOption>("1br");
  const [rentCheckResult, setRentCheckResult] = useState<{
    percentDiff: number;
    userRent: number;
    average: number;
  } | null>(null);
  const [streetViewImageFailed, setStreetViewImageFailed] = useState(false);

  const googleMapsBrowserKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

  const streetViewUrl = useMemo(() => {
    if (!googleMapsBrowserKey) return null;
    const hn = houseNumber.trim().replace(/\s+/g, " ");
    const sn = streetName.trim();
    const zip5 = zipCode.replace(/\D/g, "").slice(0, 5);
    if (!hn || !sn || zip5.length !== 5) return null;
    const address = `${hn} ${sn}`;
    const zip = zip5;
    const location = encodeURIComponent(`${address},${zip}`);
    return `https://maps.googleapis.com/maps/api/streetview?size=800x400&location=${location}&key=${googleMapsBrowserKey}`;
  }, [googleMapsBrowserKey, houseNumber, streetName, zipCode]);

  useEffect(() => {
    setStreetViewImageFailed(false);
  }, [streetViewUrl]);

  useEffect(() => {
    if (resultsTab !== "owner" || complaintCount === null) return;
    let cancelled = false;
    const headers = { "X-App-Token": APP_TOKEN };
    void (async () => {
      const anchorRows = portfolioAnchorBuildingIds.map((id) => ({ buildingid: id }));
      const src = pickPortfolioNameSource(hpdRegistrationContacts);
      const addrRow = pickRegistrationRowWithBusinessAddress(hpdRegistrationContacts);

      const namePromise = (async () => {
        if (!src) {
          if (!cancelled) setPortfolioOtherBuildingsCount(null);
          return;
        }
        try {
          const n = await fetchPortfolioOtherBuildingsCount(
            src.row.firstname ?? "",
            src.row.lastname ?? "",
            anchorRows,
            headers,
          );
          if (!cancelled) setPortfolioOtherBuildingsCount(n);
        } catch {
          if (!cancelled) setPortfolioOtherBuildingsCount(null);
        }
      })();

      const addressPromise = (async () => {
        if (!addrRow || !buildBusinessAddressWhereClause(addrRow)) {
          if (!cancelled) setAddressNetworkOtherBuildingsCount(null);
          return;
        }
        try {
          const n = await fetchAddressNetworkOtherBuildingsCount(addrRow, anchorRows, headers);
          if (!cancelled) setAddressNetworkOtherBuildingsCount(n);
        } catch {
          if (!cancelled) setAddressNetworkOtherBuildingsCount(null);
        }
      })();

      const trendsPromise = (async () => {
        try {
          const t = await fetchPortfolioViolationTrends(hpdRegistrationContacts, headers);
          if (!cancelled) setPortfolioTrends(t);
        } catch {
          if (!cancelled) setPortfolioTrends(null);
        }
      })();

      await Promise.all([namePromise, addressPromise, trendsPromise]);
    })();
    return () => {
      cancelled = true;
    };
  }, [resultsTab, complaintCount, hpdRegistrationContacts, portfolioAnchorBuildingIds]);

  const safetyLevel = useMemo(() => {
    if (complaintCount === null) return null;
    return getSafetyLevel(complaintCount);
  }, [complaintCount]);

  const categoryCardClass = useMemo(() => {
    const base =
      "rounded-2xl bg-white p-8 text-[#1A1A1A] shadow-lg md:p-10 border border-stone-100/90";
    if (safetyLevel === "Red") {
      return `${base} border-rose-200/60 bg-gradient-to-b from-[#fff1f2] via-[#fff5f5] to-white`;
    }
    if (safetyLevel === "Yellow") {
      return `${base} border-amber-200/50 bg-gradient-to-b from-[#fffbeb] to-white`;
    }
    return base;
  }, [safetyLevel]);

  const summaryBoxClass = useMemo(() => {
    const base =
      "flex flex-col rounded-2xl border border-stone-100/90 bg-white p-6 text-[#1A1A1A] shadow-lg md:p-8";
    if (safetyLevel === "Red") {
      return `${base} border-rose-200/50 bg-gradient-to-b from-[#fff1f2] to-white`;
    }
    if (safetyLevel === "Yellow") {
      return `${base} border-amber-200/50 bg-gradient-to-b from-[#fffbeb] to-white`;
    }
    return base;
  }, [safetyLevel]);

  const safetyScoreBadgeClass = useMemo(() => {
    if (safetyLevel === "Green") {
      return "border border-emerald-200/80 bg-emerald-50/90 text-emerald-950";
    }
    if (safetyLevel === "Yellow") {
      return "border border-amber-200/80 bg-amber-50/90 text-amber-950";
    }
    return "border border-rose-200/80 bg-rose-50/95 text-rose-950";
  }, [safetyLevel]);

  const visibleHpdViolations = useMemo(() => {
    const base = showArchive
      ? hpdViolations
      : hpdViolations.filter((row) => isWithinLastFiveYears(row.inspectiondate));
    return [...base].sort((a, b) => {
      const tb = parseDateForSort(b.inspectiondate)?.getTime() ?? 0;
      const ta = parseDateForSort(a.inspectiondate)?.getTime() ?? 0;
      return tb - ta;
    });
  }, [hpdViolations, showArchive]);

  const sortedTenant311Rows = useMemo(() => {
    return [...tenant311Rows].sort((a, b) => {
      const tb = parseDateForSort(b.created_date)?.getTime() ?? 0;
      const ta = parseDateForSort(a.created_date)?.getTime() ?? 0;
      return tb - ta;
    });
  }, [tenant311Rows]);

  const heatSeverityBadge = useMemo(
    () => getHeatComplaintSeverity(heatHotWater311Last12Months ?? 0),
    [heatHotWater311Last12Months],
  );

  const openHpdViolationsCount = useMemo(
    () => hpdViolations.filter((row) => isHpdViolationOpen(row.currentstatus)).length,
    [hpdViolations],
  );

  const ownerContactRow = useMemo(
    () => pickOwnerContactRow(hpdRegistrationContacts),
    [hpdRegistrationContacts],
  );

  const managingAgentContactRow = useMemo(
    () => pickManagingAgentContactRow(hpdRegistrationContacts),
    [hpdRegistrationContacts],
  );

  const headOfficerContactRow = useMemo(
    () => pickHeadOfficerContactRow(hpdRegistrationContacts),
    [hpdRegistrationContacts],
  );

  const managingAgentPhoneDigits = useMemo(
    () =>
      managingAgentContactRow ? extractRegistrationPhoneDigits(managingAgentContactRow) : null,
    [managingAgentContactRow],
  );

  /** Aligns with Portfolio Analysis “Large” (10+ name portfolio) or address-network hub. */
  const negotiationOperatorIsInstitutional = useMemo(() => {
    if (portfolioOtherBuildingsCount !== null) return portfolioOtherBuildingsCount >= 10;
    if (addressNetworkOtherBuildingsCount !== null) {
      return addressNetworkOtherBuildingsCount >= ADDRESS_NETWORK_HUB_THRESHOLD;
    }
    return false;
  }, [portfolioOtherBuildingsCount, addressNetworkOtherBuildingsCount]);

  useEffect(() => {
    if (!negotiationStrategyModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNegotiationStrategyModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [negotiationStrategyModalOpen]);

  function handleRentCompare() {
    const userRent = parseMonthlyRentInput(rentCheckMonthly);
    if (userRent == null) {
      setRentCheckResult(null);
      return;
    }
    const zip5 = zipCode.replace(/\D/g, "").slice(0, 5);
    const average = getNeighborhoodRentAverage(zip5 || "00000", rentCheckBedroom);
    const percentDiff = ((userRent - average) / average) * 100;
    setRentCheckResult({ percentDiff, userRent, average });
  }

  async function checkBuilding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setComplaintCount(null);
    setDobComplaintsTotalOnFile(null);
    setDobComplaints([]);
    setHpdViolations([]);
    setActiveRatSignInspections([]);
    setHeatHotWater311Last12Months(null);
    setHeat311Rows([]);
    setTenant311Rows([]);
    setTenant311Count(null);
    setShowArchive(false);
    setResultsTab("overview");
    setHpdRegistrationContacts([]);
    setRentCheckMonthly("");
    setRentCheckBedroom("1br");
    setRentCheckResult(null);
    setStreetViewImageFailed(false);
    setPortfolioOtherBuildingsCount(null);
    setAddressNetworkOtherBuildingsCount(null);
    setPortfolioAnchorBuildingIds([]);
    setNegotiationStrategyModalOpen(false);
    setPortfolioTrends(null);

    const trimmedHouseNumber = houseNumber.trim().replace(/\s+/g, " ");
    const trimmedStreetName = streetName.trim().toUpperCase();
    const zipDigits = zipCode.replace(/\D/g, "").slice(0, 5);

    if (!trimmedHouseNumber || !trimmedStreetName) {
      setError("Enter both a house number and street name.");
      return;
    }
    if (zipDigits.length !== 5) {
      setError("Enter a valid 5-digit ZIP code.");
      return;
    }
    const trimmedZip = zipDigits;

    const escapedHouseNumber = trimmedHouseNumber.replace(/'/g, "''");
    const escapedZip = trimmedZip.replace(/'/g, "''");
    const streetVariants = buildStreetNameVariants(trimmedStreetName);
    const streetOrDob = streetVariants
      .map((v) => `house_street='${v.replace(/'/g, "''")}'`)
      .join(" OR ");
    const whereClause = `house_number='${escapedHouseNumber}' AND zip_code='${escapedZip}' AND (${streetOrDob})`;

    /** `date_entered` is text `MM/DD/YYYY`; convert to `YYYY-MM-DD` for lexicographic SoQL compare. */
    const dobDateEnteredIsoExpr =
      "(substring(date_entered,7,4)||'-'||substring(date_entered,1,2)||'-'||substring(date_entered,4,2))";
    const safetyCutoff24Mo = new Date();
    safetyCutoff24Mo.setMonth(safetyCutoff24Mo.getMonth() - 24);
    const cutoffY = safetyCutoff24Mo.getFullYear();
    const cutoffM = String(safetyCutoff24Mo.getMonth() + 1).padStart(2, "0");
    const cutoffD = String(safetyCutoff24Mo.getDate()).padStart(2, "0");
    const safetyScoreCutoffIso = `${cutoffY}-${cutoffM}-${cutoffD}`;
    const whereClauseDobLast24Months = `${whereClause} AND ${dobDateEnteredIsoExpr} >= '${safetyScoreCutoffIso}'`;

    const countParams = new URLSearchParams({
      $select: "count(*) as complaint_count",
      $where: whereClauseDobLast24Months,
    });
    const countAllTimeParams = new URLSearchParams({
      $select: "count(*) as complaint_count",
      $where: whereClause,
    });
    const dobListParams = new URLSearchParams({
      $select:
        "complaint_number,status,complaint_category,date_entered,inspection_date,disposition_code,unit",
      $where: whereClause,
      $order: "date_entered DESC",
      $limit: "500",
    });

    const hpdStreetClause = sqlUpperStreetIn("streetname", streetVariants);
    const hpdWhere = `housenumber='${escapedHouseNumber}' AND zip='${escapedZip}' AND ${hpdStreetClause}`;
    const hpdParams = new URLSearchParams({
      $select:
        "violationid,registrationid,housenumber,streetname,class,novdescription,currentstatus,inspectiondate",
      $where: hpdWhere,
      $order: "inspectiondate DESC",
      $limit: "25",
    });

    const hpdMdrWhere = `housenumber='${escapedHouseNumber}' AND zip='${escapedZip}' AND ${hpdStreetClause}`;
    const mdrParams = new URLSearchParams({
      $select: "registrationid,buildingid",
      $where: hpdMdrWhere,
      $limit: "50",
    });

    const rodentStreetClause = sqlUpperStreetIn("street_name", streetVariants);
    const rodentWhereAddress = `house_number='${escapedHouseNumber}' AND zip_code='${escapedZip}' AND ${rodentStreetClause}`;
    const rodentCutoff = new Date();
    rodentCutoff.setFullYear(rodentCutoff.getFullYear() - 5);
    const rodentCutoffDate = rodentCutoff.toISOString().slice(0, 10);
    const rodentParams = new URLSearchParams({
      $select:
        "house_number,street_name,inspection_date,result,inspection_type,borough",
      $where: `${rodentWhereAddress} AND result='Rat Activity' AND inspection_date >= '${rodentCutoffDate}'`,
      $order: "inspection_date DESC",
      $limit: "15",
    });

    const heatCutoff = new Date();
    heatCutoff.setFullYear(heatCutoff.getFullYear() - 1);
    const heatCutoffIso = `${heatCutoff.toISOString().slice(0, 10)}T00:00:00.000`;
    /** Exact house token at start of incident_address (avoids matching 3210… when searching 321). */
    const threeOneOneHouseMatch = `(upper(incident_address) LIKE upper('${escapedHouseNumber} %') OR upper(incident_address) LIKE upper('${escapedHouseNumber},%') OR upper(incident_address) LIKE upper('${escapedHouseNumber}-%'))`;
    const threeOneOneStreetMatch = sqlUpperStreetIn("street_name", streetVariants);
    const threeOneOneAddress = `${threeOneOneHouseMatch} AND ${threeOneOneStreetMatch} AND incident_zip='${escapedZip}'`;
    const heatWhere = `${threeOneOneAddress} AND complaint_type='HEAT/HOT WATER' AND created_date >= '${heatCutoffIso}'`;
    const heatCountParams = new URLSearchParams({
      $select: "count(*) as heat_count",
      $where: heatWhere,
    });
    const heatListParams = new URLSearchParams({
      $select: "unique_key,created_date,descriptor,complaint_type",
      $where: heatWhere,
      $order: "created_date DESC",
      $limit: "25",
    });

    const tenantCutoff = new Date();
    tenantCutoff.setFullYear(tenantCutoff.getFullYear() - 5);
    const tenantCutoffIso = `${tenantCutoff.toISOString().slice(0, 10)}T00:00:00.000`;
    const tenantWhere = `${threeOneOneAddress} AND agency='HPD' AND created_date >= '${tenantCutoffIso}'`;
    const tenantCountParams = new URLSearchParams({
      $select: "count(*) as tenant_count",
      $where: tenantWhere,
    });
    const tenantListParams = new URLSearchParams({
      $select: "unique_key,created_date,complaint_type,descriptor,status",
      $where: tenantWhere,
      $order: "created_date DESC",
      $limit: "500",
    });

    setIsLoading(true);

    try {
      const headers = {
        "X-App-Token": APP_TOKEN,
      };

      const rodentFetch = fetch(
        `${RODENT_INSPECTION_RESOURCE}?${rodentParams.toString()}`,
        { headers, cache: "no-store" },
      ).then(async (response) => {
        if (!response.ok) return [] as RodentInspectionRow[];
        const raw = (await response.json()) as RodentInspectionRow[];
        return Array.isArray(raw) ? raw : [];
      });

      const heat311Fetch = Promise.all([
        fetch(`${THREE_ONE_ONE_RESOURCE}?${heatCountParams.toString()}`, {
          headers,
          cache: "no-store",
        }),
        fetch(`${THREE_ONE_ONE_RESOURCE}?${heatListParams.toString()}`, {
          headers,
          cache: "no-store",
        }),
      ]).then(async ([countResponse, listResponse]) => {
        if (!countResponse.ok) return { count: 0, rows: [] as Heat311Row[] };
        const countRaw = (await countResponse.json()) as Array<{ heat_count?: string }>;
        const n = Number(countRaw?.[0]?.heat_count ?? 0);
        const count = Number.isFinite(n) && n >= 0 ? n : 0;
        let rows: Heat311Row[] = [];
        if (listResponse.ok) {
          const listRaw = (await listResponse.json()) as Heat311Row[];
          rows = Array.isArray(listRaw) ? listRaw : [];
        }
        return { count, rows };
      });

      const hpdFetch = fetch(`${HPD_VIOLATIONS_RESOURCE}?${hpdParams.toString()}`, {
        headers,
        cache: "no-store",
      }).then(async (response) => {
        if (!response.ok) return [] as HpdViolationRow[];
        const raw = (await response.json()) as HpdViolationRow[];
        return Array.isArray(raw) ? raw : [];
      });

      const tenant311Fetch = Promise.all([
        fetch(`${THREE_ONE_ONE_RESOURCE}?${tenantCountParams.toString()}`, {
          headers,
          cache: "no-store",
        }),
        fetch(`${THREE_ONE_ONE_RESOURCE}?${tenantListParams.toString()}`, {
          headers,
          cache: "no-store",
        }),
      ]).then(async ([countResponse, listResponse]) => {
        if (!countResponse.ok) return { count: 0, rows: [] as Tenant311Row[] };
        const countRaw = (await countResponse.json()) as Array<{ tenant_count?: string }>;
        const apiTotal = Number(countRaw?.[0]?.tenant_count ?? 0);
        const n = Number.isFinite(apiTotal) && apiTotal >= 0 ? apiTotal : 0;
        let rows: Tenant311Row[] = [];
        let rawLen = 0;
        if (listResponse.ok) {
          const listRaw = (await listResponse.json()) as Tenant311Row[];
          const raw = Array.isArray(listRaw) ? listRaw : [];
          rawLen = raw.length;
          rows = dedupe311ByUniqueKey(raw);
        }
        const tenantListLimit = 500;
        const count = !listResponse.ok
          ? n
          : rawLen < tenantListLimit
            ? rows.length
            : n;
        return { count, rows };
      });

      const mdrFetch = fetch(
        `${HPD_MULTIPLE_DWELLING_REGISTRATIONS_RESOURCE}?${mdrParams.toString()}`,
        { headers, cache: "no-store" },
      ).then(async (response) => {
        if (!response.ok) return [] as Array<{ registrationid?: string | number; buildingid?: string | number }>;
        const raw = (await response.json()) as Array<{
          registrationid?: string | number;
          buildingid?: string | number;
        }>;
        return Array.isArray(raw) ? raw : [];
      });

      const [countResponse, countAllTimeResponse, dobListResponse, hpdRows, rodentRows, heat311Result, tenant311Result, mdrRows] =
        await Promise.all([
          fetch(`${DOB_COMPLAINTS_RESOURCE}?${countParams.toString()}`, {
            headers,
            cache: "no-store",
          }),
          fetch(`${DOB_COMPLAINTS_RESOURCE}?${countAllTimeParams.toString()}`, {
            headers,
            cache: "no-store",
          }),
          fetch(`${DOB_COMPLAINTS_RESOURCE}?${dobListParams.toString()}`, {
            headers,
            cache: "no-store",
          }),
          hpdFetch.catch(() => [] as HpdViolationRow[]),
          rodentFetch.catch(() => [] as RodentInspectionRow[]),
          heat311Fetch.catch(() => ({ count: 0, rows: [] as Heat311Row[] })),
          tenant311Fetch.catch(() => ({ count: 0, rows: [] as Tenant311Row[] })),
          mdrFetch.catch(() => [] as Array<{ registrationid?: string | number }>),
        ]);

      if (!countResponse.ok) {
        throw new Error("NYC Open Data request failed.");
      }

      const data = (await countResponse.json()) as Array<{ complaint_count?: string }>;
      const count = Number(data?.[0]?.complaint_count ?? 0);

      if (!Number.isFinite(count) || count < 0) {
        throw new Error("Received unexpected complaint data.");
      }

      setComplaintCount(count);

      if (countAllTimeResponse.ok) {
        const allRaw = (await countAllTimeResponse.json()) as Array<{ complaint_count?: string }>;
        const allN = Number(allRaw?.[0]?.complaint_count ?? 0);
        setDobComplaintsTotalOnFile(Number.isFinite(allN) && allN >= 0 ? allN : null);
      } else {
        setDobComplaintsTotalOnFile(null);
      }

      let dobRows: DobComplaintRow[] = [];
      if (dobListResponse.ok) {
        const raw = (await dobListResponse.json()) as DobComplaintRow[];
        dobRows = Array.isArray(raw) ? raw : [];
        dobRows.sort(compareDobComplaintsNewestFirst);
      }
      setDobComplaints(dobRows);

      setHpdViolations(hpdRows);

      const registrationIdsFromViolations = hpdRows
        .map((r) => r.registrationid)
        .filter((id) => id != null && String(id).trim() !== "" && String(id) !== "0");
      const registrationIdsFromMdr = mdrRows.map((r) => r.registrationid);
      const regIdNums = [
        ...new Set(
          [...registrationIdsFromViolations, ...registrationIdsFromMdr].map((id) =>
            Number(String(id).trim()),
          ),
        ),
      ]
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 12);

      let regContacts: HpdRegistrationContactRow[] = [];
      if (regIdNums.length > 0) {
        const regWhere = `registrationid in (${regIdNums.join(",")})`;
        const regParams = new URLSearchParams({
          $select:
            "registrationcontactid,registrationid,type,corporationname,firstname,middleinitial,lastname,contactdescription,title,businesshousenumber,businessstreetname,businessapartment,businesscity,businessstate,businesszip",
          $where: regWhere,
          $limit: "200",
        });
        const regRes = await fetch(
          `${HPD_REGISTRATION_CONTACTS_RESOURCE}?${regParams.toString()}`,
          { headers, cache: "no-store" },
        );
        if (regRes.ok) {
          const rawC = (await regRes.json()) as HpdRegistrationContactRow[];
          regContacts = Array.isArray(rawC) ? rawC : [];
        }
      }
      setHpdRegistrationContacts(regContacts);

      setPortfolioAnchorBuildingIds(
        (mdrRows as Array<{ buildingid?: string | number }>)
          .map((r) => (r.buildingid != null ? String(r.buildingid).trim() : ""))
          .filter(Boolean),
      );

      setActiveRatSignInspections(rodentRows);
      setHeatHotWater311Last12Months(heat311Result.count);
      setHeat311Rows(heat311Result.rows);
      setTenant311Count(tenant311Result.count);
      setTenant311Rows(tenant311Result.rows);
    } catch {
      setError("Could not fetch complaints right now. Please try again.");
      setComplaintCount(null);
      setDobComplaintsTotalOnFile(null);
      setDobComplaints([]);
      setHpdRegistrationContacts([]);
      setActiveRatSignInspections([]);
      setHeatHotWater311Last12Months(null);
      setHeat311Rows([]);
      setTenant311Rows([]);
      setTenant311Count(null);
      setHpdViolations([]);
      setPortfolioOtherBuildingsCount(null);
      setAddressNetworkOtherBuildingsCount(null);
      setPortfolioTrends(null);
      setPortfolioAnchorBuildingIds([]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#FDFCFB] text-[#1A1A1A]">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-6 pb-20 md:gap-6 md:px-10 md:py-8 md:pb-20">
        <section className="border border-stone-300 bg-white px-5 py-5 md:px-6 md:py-6">
          <h1 className="font-sans text-2xl font-bold uppercase tracking-[0.12em] text-[#1A1A1A] md:text-3xl">
            NYC SNITCH
          </h1>
          <p className="mt-2 max-w-xl text-sm font-normal leading-relaxed tracking-wide text-stone-500 md:mt-2.5 md:text-[15px]">
            NYC&apos;s most transparent building background check.
          </p>

          <form
            className="mt-4 grid border border-stone-300 bg-white p-3 md:mt-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto] md:p-4"
            onSubmit={checkBuilding}
          >
            <input
              type="text"
              value={houseNumber}
              onChange={(event) => setHouseNumber(event.target.value)}
              placeholder="House number (e.g. 123)"
              className="h-12 border-b border-stone-200 bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-stone-400 outline-none md:border-b-0 md:border-r"
            />
            <input
              type="text"
              value={streetName}
              onChange={(event) => setStreetName(event.target.value)}
              placeholder="Street name (e.g. BROADWAY)"
              className="h-12 border-b border-stone-200 bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-stone-400 outline-none md:border-b-0 md:border-r"
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={10}
              value={zipCode}
              onChange={(event) => setZipCode(event.target.value)}
              placeholder="ZIP (e.g. 10029)"
              className="h-12 border-b border-stone-200 bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-stone-400 outline-none md:border-b-0 md:border-r"
            />
            <button
              type="submit"
              disabled={isLoading}
              className="h-12 bg-[#2D2926] px-6 font-serif text-sm tracking-wide text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? "Checking..." : "Check Building"}
            </button>
          </form>

          {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        </section>

        {complaintCount !== null && safetyLevel ? (
          <section className="pb-8">
            <div className="sticky top-0 z-30 -mx-6 border-b border-stone-200/90 bg-[#FDFCFB]/95 px-6 py-4 shadow-sm backdrop-blur-sm md:-mx-10">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-6">
                <h2 className="max-w-3xl font-serif text-2xl font-light leading-tight tracking-wide text-[#1A1A1A] sm:text-3xl md:text-4xl">
                  {houseNumber.trim()} {streetName.trim().toUpperCase()}{" "}
                  <span className="text-stone-500">
                    {zipCode.replace(/\D/g, "").slice(0, 5)}
                  </span>
                </h2>
                <div
                  className={`inline-flex shrink-0 flex-col items-start gap-1 rounded-2xl px-5 py-3 shadow-md md:items-end ${safetyScoreBadgeClass}`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.22em] opacity-80">
                    Safety score
                  </span>
                  <span className="font-serif text-2xl font-light md:text-3xl">{safetyLevel}</span>
                  <span className="max-w-[14rem] text-left text-xs leading-snug opacity-90 md:text-right">
                    {getSafetyLabel(safetyLevel)}
                  </span>
                  <span className="mt-1 max-w-[15rem] text-left text-[10px] leading-snug text-stone-500 md:text-right">
                    Based on activity from the last 24 months
                  </span>
                </div>
              </div>
              <nav
                className="mt-4 flex flex-wrap gap-6 border-t border-stone-200/80 pt-3 md:gap-10"
                aria-label="Building sections"
              >
                {(
                  [
                    ["overview", "Overview"],
                    ["history", "History"],
                    ["rent", "Rent Analysis"],
                    ["owner", "Owner Profile"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={resultsTab === id}
                    onClick={() => setResultsTab(id)}
                    className={`border-b-2 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] transition-colors ${
                      resultsTab === id
                        ? "border-[#1A1A1A] text-[#1A1A1A]"
                        : "border-transparent text-stone-500 hover:text-[#1A1A1A]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </div>

            <div className="mt-6 space-y-8">
              {resultsTab === "overview" && (
                <>
                  <div className="relative aspect-[2/1] w-full overflow-hidden rounded-xl border border-stone-200 bg-stone-200/80 shadow-md ring-1 ring-stone-200/60">
                    {streetViewUrl && !streetViewImageFailed ? (
                      <img
                        src={streetViewUrl}
                        alt={`Street View of ${houseNumber.trim()} ${streetName.trim().toUpperCase()}, ${zipCode.replace(/\D/g, "").slice(0, 5)}`}
                        className="h-full w-full object-cover rounded-xl"
                        onError={() => setStreetViewImageFailed(true)}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-full min-h-[10rem] w-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-stone-100 via-stone-200/90 to-stone-300/80">
                        <span
                          className="text-6xl opacity-50 grayscale sm:text-7xl md:text-8xl"
                          aria-hidden
                        >
                          🏠
                        </span>
                        <p className="px-4 text-center text-xs font-medium uppercase tracking-[0.2em] text-stone-600">
                          Building preview unavailable
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-5 md:grid-cols-3 md:gap-6">
              <div className={summaryBoxClass}>
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-end">
                  <span className="text-5xl leading-none md:text-6xl" aria-hidden>
                    🔥
                  </span>
                  <div className="min-w-0 flex-1 text-center sm:text-left">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                      Heat
                    </h3>
                    <div className="mt-3 flex flex-wrap items-end justify-center gap-3 sm:justify-start">
                      <p className="font-serif text-5xl font-light tabular-nums leading-none md:text-6xl">
                        {heatHotWater311Last12Months ?? 0}
                      </p>
                      {heatSeverityBadge ? (
                        <span
                          className={`inline-flex shrink-0 rounded-lg border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${heatSeverityBadge.className}`}
                        >
                          {heatSeverityBadge.label}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm text-stone-600">
                      Heat / hot water 311 · last 12 months
                    </p>
                  </div>
                </div>
              </div>

              <div className={summaryBoxClass}>
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-end">
                  <span className="text-5xl leading-none md:text-6xl" aria-hidden>
                    🐀
                  </span>
                  <div className="min-w-0 flex-1 text-center sm:text-left">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                      Pests
                    </h3>
                    <p className="mt-3 font-serif text-5xl font-light tabular-nums leading-none md:text-6xl">
                      {activeRatSignInspections.length}
                    </p>
                    <p className="mt-2 text-sm text-stone-600">
                      Active rat signs · DOHMH · 5 years
                    </p>
                  </div>
                </div>
              </div>

              <div className={summaryBoxClass}>
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                  <span className="text-5xl leading-none md:text-6xl" aria-hidden>
                    ⚖️
                  </span>
                  <div className="min-w-0 flex-1 space-y-4 text-center sm:text-left">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                      Legal
                    </h3>
                    <div>
                      <p className="font-serif text-4xl font-light tabular-nums md:text-5xl">
                        {hpdViolations.length}
                      </p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                        HPD violations
                      </p>
                    </div>
                    <div className="border-t border-stone-200/80 pt-3">
                      <p className="font-serif text-3xl font-light tabular-nums md:text-4xl">
                        {complaintCount}
                      </p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                        DOB complaints (safety score · last 24 mo)
                      </p>
                    </div>
                    <div className="border-t border-stone-200/80 pt-3">
                      <p className="font-serif text-3xl font-light tabular-nums md:text-4xl">
                        {tenant311Count ?? 0}
                      </p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                        Tenant 311 → HPD · 5 years
                      </p>
                    </div>
                    {hpdViolations.length === 0 && (tenant311Count ?? 0) > 0 ? (
                      <p className="rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-xs leading-snug text-stone-800">
                        Tenant reports; pending inspection.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

                  <div className="rounded-2xl border border-stone-100/90 bg-white p-6 shadow-md md:p-8">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                      Total open HPD violations
                    </p>
                    <p className="mt-2 font-serif text-4xl font-light tabular-nums text-[#1A1A1A] md:text-5xl">
                      {openHpdViolationsCount}
                    </p>
                    <p className="mt-2 text-xs text-stone-500">
                      Violations whose status still looks active (not certified closed or dismissed).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setResultsTab("history")}
                    className="inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-black transition-colors"
                  >
                    <span>View full violation history</span>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      fill="none"
                      className="h-4 w-4"
                    >
                      <path
                        d="M7.5 5.5L12 10L7.5 14.5"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </>
              )}

              {resultsTab === "rent" && (
                <div className={categoryCardClass}>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                    Rent Analysis
                  </h3>
                  <p className="mt-2 text-sm text-stone-600">
                    Compare your rent to a simple neighborhood baseline for this building&apos;s ZIP.
                  </p>
                  <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
                    <label className="block min-w-[10rem] flex-1">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                        Monthly rent
                      </span>
                      <div className="mt-2 flex h-12 items-center border border-stone-300 bg-white px-3 shadow-sm">
                        <span className="select-none pr-2 font-medium text-stone-500">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={rentCheckMonthly}
                          onChange={(e) => setRentCheckMonthly(e.target.value)}
                          placeholder="2,800"
                          className="min-w-0 flex-1 bg-transparent text-sm text-[#1A1A1A] outline-none placeholder:text-stone-400"
                          aria-label="Monthly rent in dollars"
                        />
                      </div>
                    </label>
                    <label className="block min-w-[10rem] flex-1">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                        Bedroom size
                      </span>
                      <select
                        value={rentCheckBedroom}
                        onChange={(e) =>
                          setRentCheckBedroom(e.target.value as RentBedroomOption)
                        }
                        className="mt-2 h-12 w-full border border-stone-300 bg-white px-3 text-sm text-[#1A1A1A] shadow-sm outline-none"
                        aria-label="Bedroom size"
                      >
                        <option value="studio">Studio</option>
                        <option value="1br">1BR</option>
                        <option value="2br">2BR</option>
                        <option value="3brPlus">3BR+</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={handleRentCompare}
                      className="h-12 shrink-0 border border-[#1A1A1A] bg-[#2D2926] px-8 text-xs font-semibold uppercase tracking-[0.18em] text-white shadow-sm transition hover:opacity-90"
                    >
                      Compare
                    </button>
                  </div>

                  {rentCheckResult ? (
                    <div className="mt-8 border-t border-stone-200/80 pt-8">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                        Deal meter
                      </p>
                      <p className="mt-1 text-xs text-stone-500">
                        Green = below average · Red = above average
                      </p>
                      <div className="relative mt-4 h-4 w-full">
                        <div
                          className="h-full w-full rounded-full bg-gradient-to-r from-emerald-300 via-amber-200 to-rose-400 ring-1 ring-stone-300/80"
                          aria-hidden
                        />
                        <div
                          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#1A1A1A] shadow-md"
                          style={{
                            left: `${rentDealMeterMarkerPercent(rentCheckResult.percentDiff)}%`,
                          }}
                          aria-hidden
                        />
                      </div>
                      <p className="mt-6 text-base font-medium leading-snug text-[#1A1A1A]">
                        {Math.abs(rentCheckResult.percentDiff) < 0.75 ? (
                          <>You are paying about the same as the neighborhood average.</>
                        ) : rentCheckResult.percentDiff > 0 ? (
                          <>
                            You are paying{" "}
                            <span className="text-rose-700">
                              {Math.round(Math.abs(rentCheckResult.percentDiff) * 10) / 10}%
                            </span>{" "}
                            more than the neighborhood average.
                          </>
                        ) : (
                          <>
                            You are paying{" "}
                            <span className="text-emerald-700">
                              {Math.round(Math.abs(rentCheckResult.percentDiff) * 10) / 10}%
                            </span>{" "}
                            less than the neighborhood average.
                          </>
                        )}
                      </p>
                      <p className="mt-2 text-xs text-stone-500">
                        Your rent:{" "}
                        <span className="font-medium text-[#1A1A1A]">
                          ${rentCheckResult.userRent.toLocaleString("en-US")}
                        </span>
                        {" · "}
                        Baseline for this ZIP and bedroom size:{" "}
                        <span className="font-medium text-[#1A1A1A]">
                          ${rentCheckResult.average.toLocaleString("en-US")}
                        </span>
                        /mo
                      </p>
                    </div>
                  ) : null}

                  <p className="mt-6 border-t border-stone-200/80 pt-4 text-[10px] leading-relaxed text-stone-500">
                    Baseline estimate only. Rent varies based on building age, laundry, and
                    amenities.
                  </p>
                </div>
              )}

              {resultsTab === "history" && (
                <div className="space-y-8">
                <div className="rounded-2xl border border-stone-100/90 bg-white p-6 text-sm leading-relaxed text-stone-600 shadow-md md:p-8">
                  <p>
                    <span className="font-semibold text-[#1A1A1A]">Safety score</span> counts DOB
                    complaints from the <span className="font-semibold">last 24 months</span> at this
                    address + ZIP (Green 0–2 · Yellow 3–5 · Red 6+). Older complaints are ignored for
                    the score; the DOB list below may still show full history. Higher recent counts mean
                    more city attention on the building.
                  </p>
                </div>

            {/* Winter Essentials */}
            <div className={categoryCardClass}>
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
                <span
                  className="shrink-0 text-6xl leading-none sm:text-7xl md:text-8xl"
                  aria-hidden
                >
                  🔥
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                    Winter Essentials
                  </h3>
                  <p className="mt-3 text-base leading-relaxed text-stone-600">
                    Heat &amp; hot water — 311 (last 12 months, same ZIP + street match).
                  </p>
                  <div className="mt-8 flex flex-wrap items-end gap-4">
                    <p className="font-serif text-5xl font-light tabular-nums leading-none md:text-6xl">
                      {heatHotWater311Last12Months ?? 0}
                    </p>
                    {heatSeverityBadge ? (
                      <span
                        className={`inline-flex shrink-0 rounded-lg border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${heatSeverityBadge.className}`}
                      >
                        {heatSeverityBadge.label}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm text-stone-600">
                    HEAT/HOT WATER complaint{(heatHotWater311Last12Months ?? 0) === 1 ? "" : "s"}
                  </p>
                  {heat311Rows.length === 25 && (heatHotWater311Last12Months ?? 0) > 25 ? (
                    <p className="mt-3 text-xs text-stone-500">
                      List shows 25 most recent; headline is full 12‑month count.
                    </p>
                  ) : null}
                  <ul className="mt-8 space-y-4">
                    {heat311Rows.length > 0 ? (
                      heat311Rows.map((row, index) => (
                        <li
                          key={row.unique_key ?? `${row.created_date ?? "u"}-${index}`}
                          className="flex gap-4 rounded-xl border border-stone-100 bg-white p-5 shadow-sm"
                        >
                          <span className="text-3xl leading-none md:text-4xl">🔥</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-medium text-[#1A1A1A]">
                              {row.complaint_type?.trim() || "HEAT/HOT WATER"}
                            </p>
                            <p className="mt-2 text-sm text-stone-500">
                              Filed {formatEnteredDate(row.created_date)}
                            </p>
                            {(row.descriptor?.trim() ?? "").length > 0 ? (
                              <details className="mt-3">
                                <summary className="cursor-pointer text-sm font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                  See details
                                </summary>
                                <p className="mt-3 text-sm leading-relaxed text-stone-600">
                                  {row.descriptor?.trim()}
                                </p>
                              </details>
                            ) : null}
                          </div>
                        </li>
                      ))
                    ) : (heatHotWater311Last12Months ?? 0) === 0 ? (
                      <li className="text-sm text-stone-600">No heat / hot water 311 tickets this year.</li>
                    ) : (
                      <li className="text-sm text-stone-600">Couldn&apos;t load heat request details.</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>

            {/* Legal + tenant housing */}
            <div className={categoryCardClass}>
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
                <span
                  className="shrink-0 text-6xl leading-none sm:text-7xl md:text-8xl"
                  aria-hidden
                >
                  ⚖️
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                    Housing &amp; legal record
                  </h3>
                  <p className="mt-3 text-base leading-relaxed text-stone-600">
                    HPD violations (official) and tenant 311 requests routed to HPD. Exact house, ZIP,
                    and street (with AVE / AVENUE variants).
                  </p>

                  <div className="mt-10">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                      HPD violations
                    </p>
                    <p className="mt-2 font-serif text-5xl font-light tabular-nums md:text-6xl">
                      {hpdViolations.length}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowArchive((current) => !current)}
                      className="mt-5 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-xs font-medium uppercase tracking-[0.16em] text-[#3D362F] shadow-sm transition hover:bg-stone-50"
                    >
                      {showArchive ? "Hide older violations" : "See 5-year archive"}
                    </button>
                    <ul className="mt-6 max-h-96 space-y-4 overflow-y-auto">
                      {visibleHpdViolations.length > 0 ? (
                        visibleHpdViolations.map((row, index) => {
                          const isNew = isNewComplaint(row.inspectiondate);
                          const emoji = getViolationEmoji(row.novdescription, row.class);
                          const klass =
                            row.class != null && String(row.class).trim() !== ""
                              ? `Class ${String(row.class).trim()}`
                              : "Violation";
                          const nov = row.novdescription?.trim() ?? "";

                          return (
                            <li
                              key={row.violationid ?? `${row.inspectiondate ?? "unknown"}-${index}`}
                              className="flex gap-4 rounded-xl border border-stone-100 bg-white p-5 shadow-sm"
                            >
                              <span className="text-3xl leading-none md:text-4xl">{emoji}</span>
                              <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2 text-base font-medium text-[#1A1A1A]">
                                  <span>{klass}</span>
                                  {isNew ? (
                                    <span className="rounded border border-[#C9A66B] bg-[#E8D8B8]/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3D362F]">
                                      New
                                    </span>
                                  ) : null}
                                </p>
                                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-500">
                                  <span className="inline-flex flex-wrap items-center gap-2">
                                    <span>{formatEnteredDate(row.inspectiondate)}</span>
                                    {isWithinLast30Days(row.inspectiondate) ? (
                                      <RecentBadge />
                                    ) : null}
                                  </span>
                                  <span>
                                    ·{" "}
                                    {[row.housenumber, row.streetname].filter(Boolean).join(" ") || "—"}
                                  </span>
                                </p>
                                <details className="mt-3">
                                  <summary className="cursor-pointer text-sm font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                    See details
                                  </summary>
                                  <div className="mt-3 space-y-2">
                                    {row.currentstatus ? (
                                      <p className="text-sm font-medium text-stone-700">
                                        Status: {row.currentstatus}
                                      </p>
                                    ) : null}
                                    {nov.length > 0 ? (
                                      <p className="max-h-48 overflow-y-auto text-sm leading-relaxed text-stone-600 whitespace-pre-wrap">
                                        {nov}
                                      </p>
                                    ) : (
                                      <p className="text-sm text-stone-500">No NOV description on file.</p>
                                    )}
                                  </div>
                                </details>
                              </div>
                            </li>
                          );
                        })
                      ) : (
                        <li className="text-sm text-stone-600">No HPD violations for this address.</li>
                      )}
                    </ul>
                  </div>

                  <div className="mt-12 border-t border-stone-200/80 pt-10">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                      Structural &amp; elevator issues (DOB)
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-stone-600">
                      Department of Buildings complaints at this address (same house, ZIP, and street
                      match as the safety score). Category codes are DOB&apos;s official complaint
                      types (e.g. structural, elevator, construction).
                    </p>
                    {dobComplaints.length > 0 &&
                    dobComplaintsTotalOnFile !== null &&
                    dobComplaints.length < dobComplaintsTotalOnFile ? (
                      <p className="mt-3 text-xs text-stone-500">
                        Showing {dobComplaints.length} most recent on file (API limit);{" "}
                        {dobComplaintsTotalOnFile} total DOB complaint
                        {dobComplaintsTotalOnFile === 1 ? "" : "s"} at this address (all years).
                      </p>
                    ) : null}
                    <ul className="mt-6 max-h-96 space-y-4 overflow-y-auto">
                      {dobComplaints.length > 0 ? (
                        dobComplaints.map((row, index) => {
                          const cat = (row.complaint_category ?? "").trim();
                          const label = getDobComplaintCategoryLabel(cat);
                          const isHighPriorityDobSafetyAlert = cat === "67";
                          const st = (row.status ?? "").trim();
                          const num = (row.complaint_number ?? "").trim();
                          return (
                            <li
                              key={num ? `${num}-${index}` : `dob-${index}`}
                              className="flex gap-4 rounded-xl border border-stone-100 bg-white p-5 shadow-sm"
                            >
                              <span className="text-3xl leading-none md:text-4xl" aria-hidden>
                                🏗️
                              </span>
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`text-base font-medium ${
                                    isHighPriorityDobSafetyAlert ? "text-red-700" : "text-[#1A1A1A]"
                                  }`}
                                >
                                  {isHighPriorityDobSafetyAlert ? "⚠️ " : ""}
                                  {label}
                                </p>
                                {cat ? (
                                  <p className="mt-1 text-xs tabular-nums text-stone-500">
                                    DOB code {cat}
                                  </p>
                                ) : null}
                                <p className="mt-2 text-sm font-medium text-stone-700">
                                  Status: {st || "—"}
                                </p>
                                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-500">
                                  <span>
                                    Entered {formatEnteredDate(row.date_entered)}
                                    {num ? ` · Complaint #${num}` : ""}
                                  </span>
                                  {isWithinLast30Days(row.date_entered) ? <RecentBadge /> : null}
                                </p>
                                {(row.inspection_date?.trim() ||
                                  row.disposition_code?.trim() ||
                                  row.unit?.trim()) ? (
                                  <details className="mt-3">
                                    <summary className="cursor-pointer text-sm font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                      See details
                                    </summary>
                                    <div className="mt-3 space-y-2 text-sm text-stone-600">
                                      {row.inspection_date?.trim() ? (
                                        <p>
                                          <span className="text-stone-500">Inspection: </span>
                                          {formatEnteredDate(row.inspection_date)}
                                        </p>
                                      ) : null}
                                      {row.disposition_code?.trim() ? (
                                        <p>
                                          <span className="text-stone-500">Disposition code: </span>
                                          {row.disposition_code.trim()}
                                        </p>
                                      ) : null}
                                      {row.unit?.trim() ? (
                                        <p>
                                          <span className="text-stone-500">Unit: </span>
                                          {row.unit.trim()}
                                        </p>
                                      ) : null}
                                    </div>
                                  </details>
                                ) : null}
                              </div>
                            </li>
                          );
                        })
                      ) : (dobComplaintsTotalOnFile ?? 0) > 0 || (complaintCount ?? 0) > 0 ? (
                        <li className="text-sm text-stone-600">
                          Couldn&apos;t load DOB complaint rows; the DOB counts above still reflect
                          Open Data.
                        </li>
                      ) : (
                        <li className="text-sm text-stone-600">No DOB complaints on file for this address.</li>
                      )}
                    </ul>
                  </div>

                  <div className="mt-12 border-t border-stone-200/80 pt-10">
                    <div className="flex flex-wrap items-end gap-4">
                      <span className="text-5xl leading-none md:text-6xl" aria-hidden>
                        📣
                      </span>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                          Tenant 311 → HPD
                        </p>
                        <p className="mt-1 font-serif text-5xl font-light tabular-nums md:text-6xl">
                          {tenant311Count ?? 0}
                        </p>
                        <p className="mt-2 text-xs text-stone-500">Unique requests · deduped · 5 years</p>
                      </div>
                    </div>
                    {hpdViolations.length === 0 && (tenant311Count ?? 0) > 0 ? (
                      <p className="mt-5 rounded-xl border border-amber-200/70 bg-amber-50/60 p-4 text-sm leading-relaxed text-stone-800">
                        Issues reported by tenants; pending city inspection.
                      </p>
                    ) : null}
                    {tenant311Rows.length > 0 && (tenant311Count ?? 0) > tenant311Rows.length ? (
                      <p className="mt-4 text-xs text-stone-500">
                        Showing {tenant311Rows.length} most recent; total above is full count in window.
                      </p>
                    ) : null}
                    <ul className="mt-6 max-h-96 space-y-4 overflow-y-auto">
                      {sortedTenant311Rows.length > 0 ? (
                        sortedTenant311Rows.map((row, index) => {
                          const em = get311Emoji(row.complaint_type, row.descriptor);
                          const desc = row.descriptor?.trim() ?? "";
                          return (
                            <li
                              key={row.unique_key ?? `${row.created_date ?? "u"}-${index}`}
                              className="flex gap-4 rounded-xl border border-stone-100 bg-white p-5 shadow-sm"
                            >
                              <span className="text-3xl leading-none md:text-4xl">{em}</span>
                              <div className="min-w-0 flex-1">
                                <p className="text-base font-medium text-[#1A1A1A]">
                                  {row.complaint_type?.trim() || "311 request"}
                                </p>
                                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-500">
                                  <span className="inline-flex flex-wrap items-center gap-2">
                                    <span>{formatEnteredDate(row.created_date)}</span>
                                    {isWithinLast30Days(row.created_date) ? (
                                      <RecentBadge />
                                    ) : null}
                                  </span>
                                  <span>· {row.status || "—"}</span>
                                </p>
                                {desc.length > 0 ? (
                                  <details className="mt-3">
                                    <summary className="cursor-pointer text-sm font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                      See details
                                    </summary>
                                    <p className="mt-3 text-sm leading-relaxed text-stone-600">{desc}</p>
                                  </details>
                                ) : null}
                              </div>
                            </li>
                          );
                        })
                      ) : (tenant311Count ?? 0) === 0 ? (
                        <li className="text-sm text-stone-600">No HPD-routed 311 in the last five years.</li>
                      ) : (
                        <li className="text-sm text-stone-600">Couldn&apos;t load 311 rows.</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            {/* Rodent */}
            <div className={categoryCardClass}>
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
                <span
                  className="shrink-0 text-6xl leading-none sm:text-7xl md:text-8xl"
                  aria-hidden
                >
                  🐀
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                    Rodent activity
                  </h3>
                  <p className="mt-3 text-base leading-relaxed text-stone-600">
                    DOHMH inspections with active rat signs (last five years).
                  </p>
                  <p className="mt-8 font-serif text-5xl font-light tabular-nums md:text-6xl">
                    {activeRatSignInspections.length}
                  </p>
                  <p className="mt-2 text-sm text-stone-600">Inspections with rat activity on file</p>
                  <ul className="mt-8 max-h-96 space-y-4 overflow-y-auto">
                    {activeRatSignInspections.length > 0 ? (
                      activeRatSignInspections.map((row, index) => (
                        <li
                          key={`${row.inspection_date ?? "unknown"}-${index}`}
                          className="flex gap-4 rounded-xl border border-stone-100 bg-white p-5 shadow-sm"
                        >
                          <span className="text-3xl leading-none md:text-4xl">🐀</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-base font-medium text-[#1A1A1A]">Active rat signs</p>
                            <p className="mt-2 text-sm text-stone-500">
                              {formatEnteredDate(row.inspection_date)}
                              {row.borough ? ` · ${row.borough}` : ""}
                            </p>
                            <details className="mt-3">
                              <summary className="cursor-pointer text-sm font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                See details
                              </summary>
                              <div className="mt-3 space-y-2 text-sm text-stone-600">
                                <p>
                                  <span className="text-stone-500">Result: </span>
                                  {row.result?.trim() || "—"}
                                </p>
                                <p>
                                  <span className="text-stone-500">Type: </span>
                                  {row.inspection_type || "—"}
                                </p>
                              </div>
                            </details>
                          </div>
                        </li>
                      ))
                    ) : (
                      <li className="text-sm text-stone-600">No active rat signs on record.</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
              </div>
              )}

              {resultsTab === "owner" && (
                <div className="space-y-5">
                  <div className={categoryCardClass}>
                    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
                      <span className="shrink-0 text-5xl leading-none sm:text-6xl" aria-hidden>
                        👤
                      </span>
                      <div className="min-w-0 flex-1 space-y-2">
                        <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                          Owner profile
                        </h3>
                        <p className="text-sm leading-relaxed text-stone-600">
                          From HPD Multiple Dwelling Registration contacts for this building (via
                          violations and/or address match).
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-stone-100/90 bg-white p-6 shadow-md md:p-8">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                      Registered owner
                    </p>
                    <dl className="mt-6 space-y-5">
                      {!shouldHideRegistrationCompanyName(ownerContactRow) ? (
                        <div>
                          <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                            Company name
                          </dt>
                          <dd className="mt-1.5 text-base font-medium leading-snug text-[#1A1A1A]">
                            {formatRegistrationCompanyName(ownerContactRow)}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                          Contact person
                        </dt>
                        <dd className="mt-1.5 text-[#1A1A1A]">
                          <RegistrationContactPersonValue row={ownerContactRow} />
                        </dd>
                      </div>
                      {headOfficerContactRow &&
                      !isSameRegistrationContactRow(headOfficerContactRow, ownerContactRow) ? (
                        <div>
                          <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                            Head officer
                          </dt>
                          <dd className="mt-1.5 text-[#1A1A1A]">
                            <RegistrationContactPersonValue row={headOfficerContactRow} />
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                          Business address
                        </dt>
                        <dd className="mt-1.5 text-sm leading-relaxed text-stone-700">
                          {formatRegistrationBusinessAddress(ownerContactRow)}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-2xl border border-stone-100/90 bg-white p-6 shadow-md md:p-8">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                      Registered managing agent
                    </p>
                    <dl className="mt-6 space-y-5">
                      {!shouldHideRegistrationCompanyName(managingAgentContactRow) ? (
                        <div>
                          <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                            Company name
                          </dt>
                          <dd className="mt-1.5 text-base font-medium leading-snug text-[#1A1A1A]">
                            {formatRegistrationCompanyName(managingAgentContactRow)}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                          Contact person
                        </dt>
                        <dd className="mt-1.5 text-[#1A1A1A]">
                          <RegistrationContactPersonValue row={managingAgentContactRow} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                          Business address
                        </dt>
                        <dd className="mt-1.5 text-sm leading-relaxed text-stone-700">
                          {formatRegistrationBusinessAddress(managingAgentContactRow)}
                        </dd>
                      </div>
                    </dl>
                    {managingAgentPhoneDigits ? (
                      <a
                        href={`tel:+1${managingAgentPhoneDigits}`}
                        className="mt-6 inline-flex h-11 items-center justify-center border border-stone-300 bg-[#2D2926] px-6 text-xs font-semibold uppercase tracking-[0.16em] text-white shadow-sm transition hover:opacity-90"
                      >
                        Call management
                      </a>
                    ) : null}
                  </div>

                  {portfolioOtherBuildingsCount !== null ||
                  addressNetworkOtherBuildingsCount !== null ||
                  portfolioTrends !== null ? (
                    <div className="rounded-2xl border border-stone-100/90 bg-white p-6 shadow-md md:p-8">
                      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
                        <div
                          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-stone-100 to-stone-200/80 text-[#3D362F] shadow-inner ring-1 ring-stone-200/80"
                          aria-hidden
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="h-9 w-9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 21h18M6 21V10l6-3 6 3v11M10 21v-5h4v5M10 9.5h.01M12 9.5h.01M14 9.5h.01" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                            Portfolio Analysis
                          </h3>
                          {portfolioOtherBuildingsCount !== null ? (
                            <p className="mt-4 text-base leading-relaxed text-stone-700 md:text-lg">
                              {portfolioOtherBuildingsCount >= 10 ? (
                                <>
                                  <span className="font-semibold text-[#1A1A1A]">Large Portfolio:</span>{" "}
                                  This individual is a major player with{" "}
                                  <span className="font-semibold tabular-nums text-[#1A1A1A]">
                                    {portfolioOtherBuildingsCount}
                                  </span>{" "}
                                  registered properties.
                                </>
                              ) : (
                                <>
                                  <span className="font-semibold text-[#1A1A1A]">Limited Portfolio:</span>{" "}
                                  This individual appears to be a smaller operator or local owner.
                                </>
                              )}
                            </p>
                          ) : null}
                          {addressNetworkOtherBuildingsCount !== null ? (
                            <div
                              className={
                                portfolioOtherBuildingsCount !== null ? "mt-5 border-t border-stone-200/80 pt-5" : "mt-4"
                              }
                            >
                              <p className="flex flex-wrap items-center gap-2 text-base leading-relaxed text-stone-700 md:text-lg">
                                <span>
                                  <span className="font-semibold text-[#1A1A1A]">Address Network:</span>{" "}
                                  <span className="tabular-nums font-semibold text-[#1A1A1A]">
                                    {addressNetworkOtherBuildingsCount}
                                  </span>{" "}
                                  other buildings are managed from this same office.
                                </span>
                                {addressNetworkOtherBuildingsCount >= ADDRESS_NETWORK_HUB_THRESHOLD ? (
                                  <span className="inline-flex items-center rounded-full border border-amber-200/90 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-950">
                                    Professional Management Hub
                                  </span>
                                ) : null}
                              </p>
                            </div>
                          ) : null}
                          {portfolioTrends ? (
                            <div
                              className={
                                portfolioOtherBuildingsCount !== null ||
                                addressNetworkOtherBuildingsCount !== null
                                  ? "mt-5 border-t border-stone-200/80 pt-5"
                                  : "mt-4"
                              }
                            >
                              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                                Portfolio Trends
                              </p>
                              <p className="mt-2 text-base leading-relaxed text-stone-700 md:text-lg">
                                Buildings in this portfolio average{" "}
                                <span className="font-semibold tabular-nums text-[#1A1A1A]">
                                  {portfolioTrends.avgPerBuilding}
                                </span>{" "}
                                violations per property.
                              </p>
                              {portfolioTrends.hotspotLabel ? (
                                <p className="mt-3 text-sm leading-relaxed text-amber-950 md:text-base">
                                  <span className="font-semibold">Warning:</span>{" "}
                                  {portfolioTrends.hotspotLabel} is a recurring problem in this
                                  landlord&apos;s other buildings.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="mt-6 border-t border-stone-200/80 pt-5">
                            <button
                              type="button"
                              onClick={() => setNegotiationStrategyModalOpen(true)}
                              className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-[#3D362F] shadow-sm transition hover:bg-stone-50"
                            >
                              <span className="text-amber-500" aria-hidden>
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  className="h-4 w-4"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m1.5.189v.007m0-.007v-.007m0 .007v.004m0-.004a6.01 6.01 0 011.5-.189M12 12.75V9.75m5.25 2.25a6.004 6.004 0 01-1.875.3M12 12.75a6.004 6.004 0 00-1.875-.3M18.75 9a6.75 6.75 0 11-13.5 0 6.75 6.75 0 0113.5 0z" />
                                </svg>
                              </span>
                              Get Negotiation Strategy
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <p className="text-[10px] leading-relaxed text-stone-500">
                    Data sourced from NYC Open Data — HPD Registration Contacts. Phone numbers are not
                    always published; a call link appears only when a number is present in the dataset.
                  </p>
                </div>
              )}

            </div>
          </section>
        ) : null}
      </main>

      {negotiationStrategyModalOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="negotiation-strategy-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/45"
            aria-label="Close dialog"
            onClick={() => setNegotiationStrategyModalOpen(false)}
          />
          <div className="relative z-10 max-h-[min(90vh,720px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl md:p-8">
            <div className="flex items-start justify-between gap-4 border-b border-stone-200/90 pb-4">
              <h2
                id="negotiation-strategy-title"
                className="font-serif text-xl font-light tracking-wide text-[#1A1A1A] md:text-2xl"
              >
                Negotiation Strategy
              </h2>
              <button
                type="button"
                onClick={() => setNegotiationStrategyModalOpen(false)}
                className="rounded-lg p-1.5 text-stone-500 transition hover:bg-stone-100 hover:text-[#1A1A1A]"
                aria-label="Close"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-5 w-5"
                  aria-hidden
                >
                  <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="mt-6 space-y-8">
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                  The Profile
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-800 md:text-base">
                  {negotiationOperatorIsInstitutional
                    ? "You are dealing with an Institutional Landlord."
                    : "You are dealing with a Local Operator."}
                </p>
              </section>
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                  The Leverage
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-800 md:text-base">
                  {negotiationOperatorIsInstitutional
                    ? "Highlight your high credit score and stability—firms this size hate 'turnover costs'."
                    : "Focus on a personal connection and offer to handle minor fixes in exchange for rent stability."}
                </p>
              </section>
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                  The Counter-Offer
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-800 md:text-base">
                  Based on the{" "}
                  <span className="font-semibold tabular-nums text-[#1A1A1A]">{hpdViolations.length}</span>{" "}
                  violations in this building, consider asking for a rent credit or a free month of
                  amenities (gym/storage) to compensate for management delays.
                </p>
              </section>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="mt-auto border-t border-stone-200/80 bg-[#FDFCFB]">
        <div className="mx-auto max-w-5xl px-6 py-5 md:px-10 md:py-6">
          <p className="text-[10px] leading-relaxed text-gray-400">
            Data for this tool is sourced from NYC Open Data and is provided for informational
            purposes only. While reasonable efforts are made to reflect the underlying dataset,
            no guarantee is made as to completeness, accuracy, or timeliness, and the creators
            of this application accept no liability for decisions made or actions taken based on
            this information.
          </p>
        </div>
      </footer>
    </div>
  );
}
