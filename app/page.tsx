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

      const [countResponse, hpdRows, rodentRows, heat311Result] = await Promise.all([
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
    } catch {
      setError("Could not fetch complaints right now. Please try again.");
      setActiveRatSignInspections([]);
      setHeatHotWater311Last12Months(null);
      setHeat311Rows([]);
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
          <section className={`border p-10 ${safetyStyles}`}>
            <h2 className="font-serif text-3xl font-light tracking-wide">
              {houseNumber.trim()} {streetName.trim().toUpperCase()}{" "}
              <span className="text-stone-600">
                {zipCode.replace(/\D/g, "").slice(0, 5)}
              </span>
            </h2>
            <p className="mt-6 text-lg">
              Complaints found: <span className="font-bold">{complaintCount}</span>
            </p>
            <p className="mt-3 text-lg">
              Safety signal:{" "}
              <span className="inline-flex items-center border border-[#C9A66B] bg-[#E8D8B8]/45 px-3 py-1 text-sm font-semibold tracking-wide text-[#3D362F]">
                {safetyLevel} - {getSafetyLabel(safetyLevel)}
              </span>
            </p>
            <p className="mt-4 text-sm text-stone-600">
              Thresholds: Green (0-2), Yellow (3-5), Red (6+).
            </p>

            <div className="mt-8 border-t border-stone-200 pt-6">
              <h3 className="text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                HPD Violations
              </h3>
              <p className="mt-2 text-xs text-stone-600">
                Housing Maintenance Code violations matched by house number and ZIP (includes open
                and closed records). HPD may show a different street name than DOB for the same
                building. The count above is DOB complaints for the street name you entered.
              </p>
              <button
                type="button"
                onClick={() => setShowArchive((current) => !current)}
                className="mt-4 border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-[#3D362F] transition hover:bg-stone-50"
              >
                {showArchive ? "Hide Archive" : "See Archive"}
              </button>
              <div className="mt-4 max-h-96 overflow-y-auto">
                {visibleHpdViolations.length > 0 ? (
                  <ul>
                    {visibleHpdViolations.map((row, index) => {
                      const isNew = isNewComplaint(row.inspectiondate);
                      const title =
                        row.class != null && String(row.class).trim() !== ""
                          ? `Class ${String(row.class).trim()} violation`
                          : "HPD violation";

                      return (
                        <li
                          key={row.violationid ?? `${row.inspectiondate ?? "unknown"}-${index}`}
                          className="border-b border-stone-200 py-4 text-sm text-[#1A1A1A]"
                        >
                          <p className="flex flex-wrap items-center gap-2 font-serif text-lg font-light text-[#1A1A1A]">
                            <span>{title}</span>
                            {isNew ? (
                              <span className="border border-[#C9A66B] bg-[#E8D8B8]/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3D362F]">
                                New
                              </span>
                            ) : null}
                          </p>
                          <p className="mt-1 text-[11px] leading-snug text-stone-500">
                            {row.novdescription?.trim() || "No NOV description on file."}
                          </p>
                          <p className="mt-2 text-xs tracking-wide text-stone-600">
                            HPD address:{" "}
                            {[row.housenumber, row.streetname].filter(Boolean).join(" ") || "—"}
                          </p>
                          <p className="mt-1 text-xs tracking-wide text-stone-600">
                            Status: {row.currentstatus || "Not specified"}
                          </p>
                          <p className="mt-1 text-xs tracking-wide text-stone-600">
                            Inspection: {formatEnteredDate(row.inspectiondate)}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="border-b border-stone-200 py-4 text-sm text-stone-600">
                    No HPD violations found for this address.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-8 border-t border-stone-200 pt-6">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                <span className="text-base normal-case tracking-normal" aria-hidden>
                  🔥
                </span>
                Winter Essentials
              </h3>
              <p className="mt-2 text-xs text-stone-600">
                311 service requests for heat or hot water at this address (last 12 months).
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="font-serif text-2xl font-light text-[#1A1A1A]">
                  <span className="font-semibold">{heatHotWater311Last12Months ?? 0}</span>{" "}
                  HEAT/HOT WATER complaint
                  {(heatHotWater311Last12Months ?? 0) === 1 ? "" : "s"}
                </p>
                {heatSeverityBadge ? (
                  <span
                    className={`inline-flex shrink-0 border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${heatSeverityBadge.className}`}
                  >
                    {heatSeverityBadge.label}
                  </span>
                ) : null}
              </div>
              {heat311Rows.length === 25 &&
              (heatHotWater311Last12Months ?? 0) > 25 ? (
                <p className="mt-1 text-[11px] text-stone-500">
                  List shows the 25 most recent; the total above is the full count for the last
                  12 months.
                </p>
              ) : null}
              <div className="mt-4 max-h-72 overflow-y-auto">
                {heat311Rows.length > 0 ? (
                  <ul>
                    {heat311Rows.map((row, index) => (
                      <li
                        key={row.unique_key ?? `${row.created_date ?? "u"}-${index}`}
                        className="border-b border-stone-200 py-4 text-sm text-[#1A1A1A]"
                      >
                        <p className="font-serif text-lg font-light text-[#1A1A1A]">
                          {row.complaint_type?.trim() || "HEAT/HOT WATER"}
                        </p>
                        <p className="mt-1 text-[11px] leading-snug text-stone-500">
                          {row.descriptor?.trim() || "No descriptor provided."}
                        </p>
                        <p className="mt-2 text-xs tracking-wide text-stone-600">
                          Filed: {formatEnteredDate(row.created_date)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (heatHotWater311Last12Months ?? 0) === 0 ? (
                  <p className="border-b border-stone-200 py-4 text-sm text-stone-600">
                    No heat or hot water 311 requests in the last 12 months.
                  </p>
                ) : (
                  <p className="border-b border-stone-200 py-4 text-sm text-stone-600">
                    Details for these requests could not be loaded.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-8 border-t border-stone-200 pt-6">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.28em] text-[#3D362F]">
                <span className="text-base normal-case tracking-normal" aria-hidden>
                  🐀
                </span>
                Rodent Activity
              </h3>
              <p className="mt-2 text-xs text-stone-600">
                Recent DOHMH inspections at this address where active rat signs were recorded
                (last five years).
              </p>
              <div className="mt-4 max-h-96 overflow-y-auto">
                {activeRatSignInspections.length > 0 ? (
                  <ul>
                    {activeRatSignInspections.map((row, index) => (
                      <li
                        key={`${row.inspection_date ?? "unknown"}-${index}`}
                        className="border-b border-stone-200 py-4 text-sm text-[#1A1A1A]"
                      >
                        <p className="font-serif text-lg font-light text-[#1A1A1A]">
                          Active Rat Signs
                        </p>
                        <p className="mt-1 text-[11px] leading-snug text-stone-500">
                          {row.result?.trim() || "No inspection result text."}
                        </p>
                        <p className="mt-2 text-xs tracking-wide text-stone-600">
                          Inspection date: {formatEnteredDate(row.inspection_date)}
                        </p>
                        <p className="mt-1 text-xs tracking-wide text-stone-600">
                          Inspection type: {row.inspection_type || "Not specified"}
                        </p>
                        <p className="mt-1 text-xs tracking-wide text-stone-600">
                          Borough: {row.borough || "Not specified"}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-b border-stone-200 py-4 text-sm text-stone-600">
                    No recent active rat signs found for this address.
                  </p>
                )}
              </div>
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
