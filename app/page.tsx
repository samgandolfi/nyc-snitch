"use client";

import { FormEvent, useMemo, useState } from "react";

type SafetyLevel = "Green" | "Yellow" | "Red";

/** DOB complaint count only; violation details come from HPD (wvxf-dwi5). */
type HpdViolationRow = {
  violationid?: string;
  housenumber?: string;
  streetname?: string;
  class?: string;
  novdescription?: string;
  currentstatus?: string;
  inspectiondate?: string;
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

function formatEnteredDate(value?: string): string {
  if (!value) return "Unknown date";
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsedDate);
}

function isWithinLastFiveYears(value?: string): boolean {
  if (!value) return false;
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return false;
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
    const tb = new Date(b.created_date ?? 0).getTime();
    const ta = new Date(a.created_date ?? 0).getTime();
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
  const [complaintCount, setComplaintCount] = useState<number | null>(null);
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
  const [error, setError] = useState("");

  const safetyLevel = useMemo(() => {
    if (complaintCount === null) return null;
    return getSafetyLevel(complaintCount);
  }, [complaintCount]);

  const safetyStyles = useMemo(() => {
    return "border-stone-300 bg-white text-[#1A1A1A]";
  }, [safetyLevel]);

  const visibleHpdViolations = useMemo(() => {
    if (showArchive) return hpdViolations;
    return hpdViolations.filter((row) => isWithinLastFiveYears(row.inspectiondate));
  }, [hpdViolations, showArchive]);

  const heatSeverityBadge = useMemo(
    () => getHeatComplaintSeverity(heatHotWater311Last12Months ?? 0),
    [heatHotWater311Last12Months],
  );

  async function checkBuilding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setComplaintCount(null);
    setHpdViolations([]);
    setActiveRatSignInspections([]);
    setHeatHotWater311Last12Months(null);
    setHeat311Rows([]);
    setTenant311Rows([]);
    setTenant311Count(null);
    setShowArchive(false);

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
    const escapedStreetName = trimmedStreetName.replace(/'/g, "''");
    const escapedZip = trimmedZip.replace(/'/g, "''");
    const whereClause = `house_number='${escapedHouseNumber}' AND house_street='${escapedStreetName}' AND zip_code='${escapedZip}'`;

    const countParams = new URLSearchParams({
      $select: "count(*) as complaint_count",
      $where: whereClause,
    });

    /** House + ZIP only: HPD often uses a different street label than DOB for the same lot
     *  (e.g. corner buildings: Beekman vs Catherine). No status filter — open and closed both appear. */
    const hpdWhere = `housenumber='${escapedHouseNumber}' AND zip='${escapedZip}'`;
    const hpdParams = new URLSearchParams({
      $select:
        "violationid,housenumber,streetname,class,novdescription,currentstatus,inspectiondate",
      $where: hpdWhere,
      $order: "inspectiondate DESC",
      $limit: "25",
    });

    const rodentWhereAddress = `house_number='${escapedHouseNumber}' AND upper(street_name)='${escapedStreetName}' AND zip_code='${escapedZip}'`;
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
    const streetFirstWord =
      trimmedStreetName.split(/\s+/).find((token) => token.length > 0) ?? trimmedStreetName;
    const escapedStreetFirstWord = streetFirstWord.replace(/'/g, "''");
    const heatHousePrefixPattern = `${escapedHouseNumber}%`;
    const heatAddressMatch = `incident_address LIKE '${heatHousePrefixPattern}' AND incident_address LIKE '%${escapedStreetFirstWord}%'`;
    const heatWhere = `${heatAddressMatch} AND incident_zip='${escapedZip}' AND complaint_type='HEAT/HOT WATER' AND created_date >= '${heatCutoffIso}'`;
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
    const tenantWhere = `${heatAddressMatch} AND incident_zip='${escapedZip}' AND agency='HPD' AND created_date >= '${tenantCutoffIso}'`;
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

      const [countResponse, hpdRows, rodentRows, heat311Result, tenant311Result] =
        await Promise.all([
          fetch(
            `https://data.cityofnewyork.us/resource/vztk-gaf7.json?${countParams.toString()}`,
            {
              headers,
              cache: "no-store",
            },
          ),
          hpdFetch.catch(() => [] as HpdViolationRow[]),
          rodentFetch.catch(() => [] as RodentInspectionRow[]),
          heat311Fetch.catch(() => ({ count: 0, rows: [] as Heat311Row[] })),
          tenant311Fetch.catch(() => ({ count: 0, rows: [] as Tenant311Row[] })),
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
      setHpdViolations(hpdRows);
      setActiveRatSignInspections(rodentRows);
      setHeatHotWater311Last12Months(heat311Result.count);
      setHeat311Rows(heat311Result.rows);
      setTenant311Count(tenant311Result.count);
      setTenant311Rows(tenant311Result.rows);
    } catch {
      setError("Could not fetch complaints right now. Please try again.");
      setActiveRatSignInspections([]);
      setHeatHotWater311Last12Months(null);
      setHeat311Rows([]);
      setTenant311Rows([]);
      setTenant311Count(null);
      setHpdViolations([]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A]">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-8 py-14 md:px-12">
        <section className="border border-stone-300 bg-white p-10">
          <p className="text-xs font-medium uppercase tracking-[0.32em] text-[#3D362F]">
            NYC Building Snitch
          </p>
          <h1 className="mt-5 font-serif text-5xl font-light tracking-wide text-[#1A1A1A] md:text-6xl">
          The Landlord Red-Flag Index
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-stone-600">
            Search by house number, street name, and ZIP code to review complaint activity from
            NYC Open Data and narrow results to the building you mean.
          </p>

          <form
            className="mt-10 grid border border-stone-300 bg-white p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto]"
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

          {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        </section>

        {complaintCount !== null && safetyLevel ? (
          <section className={`border border-stone-300 bg-white p-8 md:p-10 ${safetyStyles}`}>
            <h2 className="font-serif text-3xl font-light tracking-wide md:text-4xl">
              {houseNumber.trim()} {streetName.trim().toUpperCase()}{" "}
              <span className="text-stone-500">
                {zipCode.replace(/\D/g, "").slice(0, 5)}
              </span>
            </h2>

            <div className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-6">
              <div className="flex items-end gap-3">
                <span className="text-5xl leading-none" aria-hidden>
                  📋
                </span>
                <div>
                  <p className="font-serif text-5xl font-light leading-none tabular-nums text-[#1A1A1A]">
                    {complaintCount}
                  </p>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                    DOB complaints
                  </p>
                </div>
              </div>
              <div className="flex items-end gap-3">
                <span className="text-5xl leading-none" aria-hidden>
                  {safetyLevel === "Green" ? "🟢" : safetyLevel === "Yellow" ? "🟡" : "🔴"}
                </span>
                <div>
                  <p className="font-serif text-3xl font-light leading-none text-[#1A1A1A]">
                    {safetyLevel}
                  </p>
                  <p className="mt-2 max-w-xs text-sm leading-snug text-stone-600">
                    {getSafetyLabel(safetyLevel)}
                  </p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-[11px] text-stone-500">
              Signal: Green 0–2 · Yellow 3–5 · Red 6+ (same address + ZIP as your search).
            </p>

            {/* Winter Essentials — prominent */}
            <div className="mt-10 rounded-lg border border-amber-200/80 bg-gradient-to-br from-amber-50/90 to-white p-6 md:p-8">
              <h3 className="flex flex-wrap items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                <span className="text-4xl normal-case leading-none tracking-normal" aria-hidden>
                  🔥
                </span>
                <span>Winter Essentials</span>
              </h3>
              <p className="mt-3 text-sm text-stone-600">
                Heat &amp; hot water — 311 (last 12 months, same ZIP + address match).
              </p>
              <div className="mt-6 flex flex-wrap items-end gap-4">
                <div className="flex items-end gap-2">
                  <span className="text-5xl leading-none">🔥</span>
                  <p className="font-serif text-5xl font-light tabular-nums leading-none text-[#1A1A1A]">
                    {heatHotWater311Last12Months ?? 0}
                  </p>
                </div>
                {heatSeverityBadge ? (
                  <span
                    className={`inline-flex shrink-0 border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${heatSeverityBadge.className}`}
                  >
                    {heatSeverityBadge.label}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm text-stone-600">
                HEAT/HOT WATER complaint{(heatHotWater311Last12Months ?? 0) === 1 ? "" : "s"}
              </p>
              {heat311Rows.length === 25 && (heatHotWater311Last12Months ?? 0) > 25 ? (
                <p className="mt-2 text-[11px] text-stone-500">
                  List shows 25 most recent; headline is full 12‑month count.
                </p>
              ) : null}
              <ul className="mt-5 space-y-3">
                {heat311Rows.length > 0 ? (
                  heat311Rows.map((row, index) => (
                    <li
                      key={row.unique_key ?? `${row.created_date ?? "u"}-${index}`}
                      className="flex gap-3 rounded-md border border-stone-200/80 bg-white/80 px-3 py-3"
                    >
                      <span className="text-2xl leading-none">🔥</span>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-[#1A1A1A]">
                          {row.complaint_type?.trim() || "HEAT/HOT WATER"}
                        </p>
                        <p className="text-xs text-stone-500">
                          Filed {formatEnteredDate(row.created_date)}
                        </p>
                        {(row.descriptor?.trim() ?? "").length > 0 ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                              See details
                            </summary>
                            <p className="mt-2 text-[11px] leading-relaxed text-stone-600">
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

            {/* Housing: violations + tenants */}
            <div className="mt-10 border-t border-stone-200 pt-8">
              <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                Housing snapshot
              </h3>
              <p className="mt-2 text-sm text-stone-600">
                Legal violations (HPD) vs tenant-filed 311 (routed to HPD). ZIP + house # match;
                street labels can differ on corners.
              </p>

              <div className="mt-6 flex flex-wrap items-end gap-4 border-b border-stone-100 pb-6">
                <span className="text-5xl leading-none">⚖️</span>
                <div>
                  <p className="font-serif text-5xl font-light tabular-nums leading-none">
                    {hpdViolations.length}
                  </p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                    HPD violations (legal record)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowArchive((current) => !current)}
                className="mt-4 border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-[#3D362F] transition hover:bg-stone-50"
              >
                {showArchive ? "Hide older violations" : "See 5-year archive"}
              </button>
              <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto">
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
                        className="flex gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
                      >
                        <span className="text-3xl leading-none">{emoji}</span>
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-medium text-[#1A1A1A]">
                            <span>{klass}</span>
                            {isNew ? (
                              <span className="border border-[#C9A66B] bg-[#E8D8B8]/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3D362F]">
                                New
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-stone-500">
                            {formatEnteredDate(row.inspectiondate)} ·{" "}
                            {[row.housenumber, row.streetname].filter(Boolean).join(" ") || "—"}
                          </p>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                              See details
                            </summary>
                            <div className="mt-2 space-y-2">
                              {row.currentstatus ? (
                                <p className="text-[11px] font-medium text-stone-700">
                                  Status: {row.currentstatus}
                                </p>
                              ) : null}
                              {nov.length > 0 ? (
                                <p className="max-h-48 overflow-y-auto text-[11px] leading-relaxed text-stone-600 whitespace-pre-wrap">
                                  {nov}
                                </p>
                              ) : (
                                <p className="text-[11px] text-stone-500">No NOV description on file.</p>
                              )}
                            </div>
                          </details>
                        </div>
                      </li>
                    );
                  })
                ) : (
                  <li className="text-sm text-stone-600">No HPD violations for this house + ZIP.</li>
                )}
              </ul>

              <div className="mt-10 flex flex-wrap items-end gap-4 border-b border-stone-100 pb-6">
                <span className="text-5xl leading-none">📣</span>
                <div>
                  <p className="font-serif text-5xl font-light tabular-nums leading-none">
                    {tenant311Count ?? 0}
                  </p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                    Tenant 311 → HPD (5 yr, deduped)
                  </p>
                </div>
              </div>
              {hpdViolations.length === 0 && (tenant311Count ?? 0) > 0 ? (
                <p className="mt-2 rounded-md border border-amber-200/60 bg-amber-50/50 px-3 py-2 text-sm text-stone-700">
                  Issues reported by tenants; pending city inspection.
                </p>
              ) : null}
              {tenant311Rows.length > 0 && (tenant311Count ?? 0) > tenant311Rows.length ? (
                <p className="mt-2 text-[11px] text-stone-500">
                  Showing {tenant311Rows.length} most recent; total above is full count in window.
                </p>
              ) : null}
              <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto">
                {tenant311Rows.length > 0 ? (
                  tenant311Rows.map((row, index) => {
                    const em = get311Emoji(row.complaint_type, row.descriptor);
                    const desc = row.descriptor?.trim() ?? "";
                    return (
                      <li
                        key={row.unique_key ?? `${row.created_date ?? "u"}-${index}`}
                        className="flex gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
                      >
                        <span className="text-3xl leading-none">{em}</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-[#1A1A1A]">
                            {row.complaint_type?.trim() || "311 request"}
                          </p>
                          <p className="text-xs text-stone-500">
                            {formatEnteredDate(row.created_date)} · {row.status || "—"}
                          </p>
                          {desc.length > 0 ? (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                                See details
                              </summary>
                              <p className="mt-2 text-[11px] leading-relaxed text-stone-600">
                                {desc}
                              </p>
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

            {/* Rodent */}
            <div className="mt-10 border-t border-stone-200 pt-8">
              <div className="flex flex-wrap items-end gap-4">
                <span className="text-5xl leading-none">🐀</span>
                <div>
                  <p className="font-serif text-5xl font-light tabular-nums leading-none">
                    {activeRatSignInspections.length}
                  </p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
                    Rodent — active signs (5 yr)
                  </p>
                </div>
              </div>
              <p className="mt-3 text-sm text-stone-600">DOHMH inspections with rat activity.</p>
              <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto">
                {activeRatSignInspections.length > 0 ? (
                  activeRatSignInspections.map((row, index) => (
                    <li
                      key={`${row.inspection_date ?? "unknown"}-${index}`}
                      className="flex gap-3 rounded-md border border-stone-200 bg-white px-3 py-3"
                    >
                      <span className="text-3xl leading-none">🐀</span>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-[#1A1A1A]">Active rat signs</p>
                        <p className="text-xs text-stone-500">
                          {formatEnteredDate(row.inspection_date)}
                          {row.borough ? ` · ${row.borough}` : ""}
                        </p>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-medium text-[#3D362F] underline decoration-stone-300 underline-offset-2 hover:decoration-[#C9A66B]">
                            See details
                          </summary>
                          <div className="mt-2 space-y-1 text-[11px] text-stone-600">
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
          </section>
        ) : null}
      </main>
      <footer className="border-t border-stone-200 bg-[#FDFCFB]">
        <div className="mx-auto max-w-5xl px-8 py-6 md:px-12">
          <p className="text-xs leading-relaxed text-stone-500">
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
