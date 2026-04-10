"use client";

import { FormEvent, useMemo, useState } from "react";

type SafetyLevel = "Green" | "Yellow" | "Red";
type ComplaintActivity = {
  house_number?: string;
  house_street?: string;
  date_entered?: string;
  complaint_category?: string;
  status?: string;
  disposition_code?: string;
};

const APP_TOKEN = "x3IpcsPIypsdi03KGFDG8awmW";
const DOB_COMPLAINT_CATEGORY_LABELS: Record<string, string> = {
  "8A": "Illegal Residential Occupancy (Loft)",
  "4A": "Illegal Hotel Rooms / Airbnb in Residential Building",
  "1A": "Illegal Conversion: Commercial Space to Dwelling",
  "2K": "Structurally Compromised Building",
  "2L": "Facade (LL11/98) - Unsafe Notification",
  "4G": "Illegal Conversion - No Access Follow-Up",
  "5B": "Non-Compliance with Lightweight Materials (Fire Risk)",
  "5C": "Structural Stability Impacted (New Construction)",
};

const DISPOSITION_CODE_LABELS: Record<string, string> = {
  A1: "Buildings Violation(s) Served",
  A8: "Violation Served ✅",
  C4: "Inspector Access Denied (2nd Attempt) ❌",
  R1: "Inspection - No Follow-up Required",
};

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

function getComplaintCategoryLabel(code?: string): string {
  if (!code) return "Maintenance Report";
  const normalized = code.trim().toUpperCase();
  if (!normalized) return "Maintenance Report";
  if (DOB_COMPLAINT_CATEGORY_LABELS[normalized]) {
    return DOB_COMPLAINT_CATEGORY_LABELS[normalized];
  }
  if (normalized.startsWith("5")) return "System/Boiler Issue";
  if (normalized.startsWith("4")) return "Occupancy/Space Issue";
  return "Maintenance Report";
}

function getDispositionCodeLabel(code?: string): string {
  if (!code) return "No disposition code";
  const normalized = code.trim().toUpperCase();
  if (!normalized) return "No disposition code";
  return DISPOSITION_CODE_LABELS[normalized] || `Building Issue (Code [${normalized}])`;
}

function getCategoryEmoji(label: string, code?: string): string {
  const normalizedCode = code?.trim().toUpperCase() || "";
  if (
    label.includes("Construction") ||
    label.includes("Structural") ||
    normalizedCode.startsWith("2")
  ) {
    return "🏗️";
  }
  if (
    label.includes("Boiler") ||
    label.includes("System") ||
    normalizedCode.startsWith("5")
  ) {
    return "🚰";
  }
  if (label.includes("Occupancy") || normalizedCode.startsWith("4")) {
    return "🏢";
  }
  return "⚠️";
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

export default function Home() {
  const [houseNumber, setHouseNumber] = useState("");
  const [streetName, setStreetName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [complaintCount, setComplaintCount] = useState<number | null>(null);
  const [recentComplaints, setRecentComplaints] = useState<ComplaintActivity[]>([]);
  const [error, setError] = useState("");

  const safetyLevel = useMemo(() => {
    if (complaintCount === null) return null;
    return getSafetyLevel(complaintCount);
  }, [complaintCount]);

  const safetyStyles = useMemo(() => {
    return "border-stone-300 bg-white text-[#1A1A1A]";
  }, [safetyLevel]);

  const visibleComplaints = useMemo(() => {
    if (showArchive) return recentComplaints;
    return recentComplaints.filter((complaint) =>
      isWithinLastFiveYears(complaint.date_entered),
    );
  }, [recentComplaints, showArchive]);

  async function checkBuilding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setComplaintCount(null);
    setRecentComplaints([]);
    setShowArchive(false);

    const trimmedHouseNumber = houseNumber.trim().replace(/\s+/g, " ");
    const trimmedStreetName = streetName.trim().toUpperCase();

    if (!trimmedHouseNumber || !trimmedStreetName) {
      setError("Enter both a house number and street name.");
      return;
    }

    const escapedHouseNumber = trimmedHouseNumber.replace(/'/g, "''");
    const escapedStreetName = trimmedStreetName.replace(/'/g, "''");
    const whereClause = `house_number='${escapedHouseNumber}' AND house_street='${escapedStreetName}'`;

    const countParams = new URLSearchParams({
      $select: "count(*) as complaint_count",
      $where: whereClause,
    });

    const activityParams = new URLSearchParams({
      $select:
        "house_number,house_street,date_entered,complaint_category,status,disposition_code",
      $where: whereClause,
      $order: "date_entered DESC",
      $limit: "10",
    });

    setIsLoading(true);

    try {
      const headers = {
        "X-App-Token": APP_TOKEN,
      };

      const [countResponse, activityResponse] = await Promise.all([
        fetch(
          `https://data.cityofnewyork.us/resource/vztk-gaf7.json?${countParams.toString()}`,
          {
            headers,
            cache: "no-store",
          },
        ),
        fetch(
          `https://data.cityofnewyork.us/resource/vztk-gaf7.json?${activityParams.toString()}`,
          {
            headers,
            cache: "no-store",
          },
        ),
      ]);

      if (!countResponse.ok || !activityResponse.ok) {
        throw new Error("NYC Open Data request failed.");
      }

      const data = (await countResponse.json()) as Array<{ complaint_count?: string }>;
      const count = Number(data?.[0]?.complaint_count ?? 0);
      const activityData = (await activityResponse.json()) as ComplaintActivity[];

      if (!Number.isFinite(count) || count < 0) {
        throw new Error("Received unexpected complaint data.");
      }

      setComplaintCount(count);
      setRecentComplaints(Array.isArray(activityData) ? activityData : []);
    } catch {
      setError("Could not fetch complaints right now. Please try again.");
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
            Search by exact house number and street name to review complaint
            activity from NYC Open Data and quickly understand the building
            safety signal.
          </p>

          <form
            className="mt-10 grid border border-stone-300 bg-white p-4 md:grid-cols-[1fr_2fr_auto]"
            onSubmit={checkBuilding}
          >
            <input
              type="text"
              value={houseNumber}
              onChange={(event) => setHouseNumber(event.target.value)}
              placeholder="House number (e.g. 123)"
              className="h-12 border-r border-stone-200 bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-stone-400 outline-none"
            />
            <input
              type="text"
              value={streetName}
              onChange={(event) => setStreetName(event.target.value)}
              placeholder="Street name (e.g. BROADWAY)"
              className="h-12 border-r border-stone-200 bg-white px-4 text-sm text-[#1A1A1A] placeholder:text-stone-400 outline-none"
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
              {houseNumber.trim()} {streetName.trim().toUpperCase()}
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
                Complaints Found
              </h3>
              <button
                type="button"
                onClick={() => setShowArchive((current) => !current)}
                className="mt-4 border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium uppercase tracking-[0.16em] text-[#3D362F] transition hover:bg-stone-50"
              >
                {showArchive ? "Hide Archive" : "See Archive"}
              </button>
              <div className="mt-4 max-h-96 overflow-y-auto">
                {visibleComplaints.length > 0 ? (
                  <ul>
                    {visibleComplaints.map((complaint, index) => {
                      const categoryLabel = getComplaintCategoryLabel(
                        complaint.complaint_category,
                      );
                      const emoji = getCategoryEmoji(
                        categoryLabel,
                        complaint.complaint_category,
                      );
                      const isNew = isNewComplaint(complaint.date_entered);

                      return (
                        <li
                          key={`${complaint.date_entered ?? "unknown"}-${index}`}
                          className="border-b border-stone-200 py-4 text-sm text-[#1A1A1A]"
                        >
                          <p className="flex items-center gap-2 font-serif text-lg font-light text-[#1A1A1A]">
                            <span className="text-2xl leading-none">{emoji}</span>
                            <span>{categoryLabel}</span>
                            {isNew ? (
                              <span className="border border-[#C9A66B] bg-[#E8D8B8]/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#3D362F]">
                                New
                              </span>
                            ) : null}
                          </p>
                          <p className="mt-1 text-xs tracking-wide text-stone-600">
                            Date Entered: {formatEnteredDate(complaint.date_entered)}
                          </p>
                          <p className="mt-1 text-xs tracking-wide text-stone-600">
                            Status: {complaint.status || "No status provided"}
                          </p>
                          <p className="mt-1 text-xs tracking-wide text-stone-600">
                            Disposition: {getDispositionCodeLabel(complaint.disposition_code)}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="border-b border-stone-200 py-4 text-sm text-stone-600">
                    No specific details found.
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
