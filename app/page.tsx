"use client";

import { FormEvent, useMemo, useState } from "react";

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
const DOB_COMPLAINTS_RESOURCE =
  "https://data.cityofnewyork.us/resource/vztk-gaf7.json";

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
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [complaintCount, setComplaintCount] = useState<number | null>(null);
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
  const [error, setError] = useState("");

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
    setDobComplaints([]);
    setHpdViolations([]);
    setActiveRatSignInspections([]);
    setHeatHotWater311Last12Months(null);
    setHeat311Rows([]);
    setTenant311Rows([]);
    setTenant311Count(null);
    setShowArchive(false);
    setShowAllDetails(false);

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

    const countParams = new URLSearchParams({
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
        "violationid,housenumber,streetname,class,novdescription,currentstatus,inspectiondate",
      $where: hpdWhere,
      $order: "inspectiondate DESC",
      $limit: "25",
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

      const [countResponse, dobListResponse, hpdRows, rodentRows, heat311Result, tenant311Result] =
        await Promise.all([
          fetch(`${DOB_COMPLAINTS_RESOURCE}?${countParams.toString()}`, {
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

      let dobRows: DobComplaintRow[] = [];
      if (dobListResponse.ok) {
        const raw = (await dobListResponse.json()) as DobComplaintRow[];
        dobRows = Array.isArray(raw) ? raw : [];
      }
      setDobComplaints(dobRows);

      setHpdViolations(hpdRows);
      setActiveRatSignInspections(rodentRows);
      setHeatHotWater311Last12Months(heat311Result.count);
      setHeat311Rows(heat311Result.rows);
      setTenant311Count(tenant311Result.count);
      setTenant311Rows(tenant311Result.rows);
    } catch {
      setError("Could not fetch complaints right now. Please try again.");
      setDobComplaints([]);
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
          <section className="space-y-8 pb-6">
            {/* Address + safety score only */}
            <div className="flex flex-col items-center justify-center gap-5 px-2 text-center md:flex-row md:flex-wrap md:gap-6">
              <h2 className="max-w-4xl font-serif text-4xl font-light leading-tight tracking-wide text-[#1A1A1A] sm:text-5xl md:text-6xl lg:text-7xl">
                {houseNumber.trim()} {streetName.trim().toUpperCase()}{" "}
                <span className="text-stone-500">
                  {zipCode.replace(/\D/g, "").slice(0, 5)}
                </span>
              </h2>
              <div
                className={`inline-flex shrink-0 flex-col items-center gap-1 rounded-2xl px-5 py-3 shadow-md ${safetyScoreBadgeClass}`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] opacity-80">
                  Safety score
                </span>
                <span className="font-serif text-2xl font-light md:text-3xl">{safetyLevel}</span>
                <span className="max-w-[14rem] text-center text-xs leading-snug opacity-90">
                  {getSafetyLabel(safetyLevel)}
                </span>
              </div>
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
                        DOB complaints (safety score)
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

            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setShowAllDetails((current) => !current)}
                aria-expanded={showAllDetails}
                className="rounded-xl border border-stone-200 bg-white px-6 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#3D362F] shadow-sm transition hover:bg-stone-50"
              >
                {showAllDetails ? "Hide all details" : "Show all details"}
              </button>
            </div>

            {showAllDetails ? (
              <div className="space-y-8">
                <div className="rounded-2xl border border-stone-100/90 bg-white p-6 text-sm leading-relaxed text-stone-600 shadow-md md:p-8">
                  <p>
                    <span className="font-semibold text-[#1A1A1A]">Safety score</span> uses DOB
                    complaints at this address + ZIP (Green 0–2 · Yellow 3–5 · Red 6+). Higher counts
                    mean more city attention on the building.
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
                                <p className="mt-2 text-sm text-stone-500">
                                  {formatEnteredDate(row.inspectiondate)} ·{" "}
                                  {[row.housenumber, row.streetname].filter(Boolean).join(" ") || "—"}
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
                    complaintCount !== null &&
                    dobComplaints.length < complaintCount ? (
                      <p className="mt-3 text-xs text-stone-500">
                        Showing {dobComplaints.length} most recent (API limit); total count is{" "}
                        {complaintCount}.
                      </p>
                    ) : null}
                    <ul className="mt-6 max-h-96 space-y-4 overflow-y-auto">
                      {dobComplaints.length > 0 ? (
                        dobComplaints.map((row, index) => {
                          const cat = (row.complaint_category ?? "").trim();
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
                                <p className="text-base font-medium text-[#1A1A1A]">
                                  {cat ? (
                                    <>
                                      Category{" "}
                                      <span className="tabular-nums">{cat}</span>
                                    </>
                                  ) : (
                                    "Category not listed"
                                  )}
                                </p>
                                <p className="mt-2 text-sm font-medium text-stone-700">
                                  Status: {st || "—"}
                                </p>
                                <p className="mt-2 text-sm text-stone-500">
                                  Entered {formatEnteredDate(row.date_entered)}
                                  {num ? ` · Complaint #${num}` : ""}
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
                      ) : (complaintCount ?? 0) > 0 ? (
                        <li className="text-sm text-stone-600">
                          Couldn&apos;t load DOB complaint rows; the count above still reflects Open
                          Data.
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
                      {tenant311Rows.length > 0 ? (
                        tenant311Rows.map((row, index) => {
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
                                <p className="mt-2 text-sm text-stone-500">
                                  {formatEnteredDate(row.created_date)} · {row.status || "—"}
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
            ) : null}
          </section>
        ) : null}
      </main>
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
