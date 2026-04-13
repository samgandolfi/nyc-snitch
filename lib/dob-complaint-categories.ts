/**
 * Human-readable labels for NYC DOB complaint category codes (BIS / Open Data `complaint_category`).
 * Official reference: https://www.nyc.gov/assets/buildings/pdf/complaint_category.pdf
 * Unknown codes fall back to series heuristics or the raw code.
 */

const EXACT: Record<string, string> = {
  "01": "Accident — construction / plumbing",
  "02": "Accident — injury to the public",
  "03": "Accident — employee injury or illness",
  "04": "Asbestos — loose, friable, or mishandled",
  "05": "Debris / Junk / Storage Issue",
  "06": "Building use — overcrowding / illegal occupancy",
  "07": "Construction — after hours",
  "08": "Construction — no permit",
  "09": "Crane, derrick, or rigging",
  "10": "Debris, housekeeping, or defective sidewalk shed",
  "11": "Demolition",
  "12": "Earthwork / excavation",
  "13": "Elevator — including FDNY readiness",
  "14": "Facade / exterior wall",
  "15": "Fire protection / suppression systems",
  "16": "Gas / plumbing — illegal or defective",
  "17": "Illegal commercial occupancy or use",
  "18": "Illegal conversion of dwelling",
  "19": "Illegal single room occupancy (SRO)",
  "20": "Illegal commercial use",
  "21": "Illegal residential use",
  "22": "Illegal work — general",
  "23": "Retaining wall",
  "24": "Sidewalk — defective or unsafe",
  "25": "Stalled or abandoned construction site",
  "26": "Structural instability / unsafe building",
  "27": "Temporary structures / sidewalk bridge",
  "28": "Work contrary to approved plans",
  "29": "Zoning / land use",
  "30": "Building shaking, vibration, or structural stability",
  "31": "Retaining structure / earth support",
  "32": "Sidewalk / public way hazard",
  "33": "Construction site safety / fencing",
  "34": "Structural — beams, columns, or loads",
  "35": "Scaffold / hoist / mechanical lift",
  "36": "Work without required permits (general)",
  "37": "Certificate of occupancy / legal use",
  "38": "Residential code / habitability (DOB)",
  "39": "Unsafe building or imminent hazard",
  "40": "Building maintenance — exterior",
  "41": "Building maintenance — interior",
  "42": "Facade inspection / Local Law 11",
  "43": "Roof / bulkhead / tank",
  "44": "Windows / exterior openings",
  "45": "Fire escape / egress",
  "46": "Plumbing / sanitary",
  "47": "Mechanical / HVAC",
  "48": "Electrical",
  "49": "General building condition",
  "50": "Debris / Junk / Storage Issue",
  "73": "Illegal Occupancy / Public Assembly Issue",
  "74": "Illegal Occupancy / Public Assembly Issue",
  "81": "Boiler / Fuel System Issue",
  "82": "Boiler / Fuel System Issue",
  "85": "Boiler / Fuel System Issue",
  "1X": "Construction / structural safety",
  "6V": "Elevator / mechanical",
};

export function getDobComplaintCategoryLabel(code: string | undefined): string {
  const key = (code ?? "").trim().toUpperCase();
  if (!key) return "Category not listed";

  const exact = EXACT[key];
  if (exact) return exact;

  if (/^6[A-Z]$/.test(key)) return "Elevator / mechanical";
  if (/^1[A-Z]$/.test(key)) return "Construction / structural safety";
  if (/^2[A-Z]$/.test(key)) return "Illegal occupancy or conversion";
  if (/^3[A-Z]$/.test(key)) return "Boiler, gas, or mechanical system";
  if (/^4[A-Z]$/.test(key)) return "Building maintenance or facade";
  if (/^5[A-Z]$/.test(key)) return "Construction enforcement or site safety";
  if (/^7[A-Z]$/.test(key)) return "Mechanical, equipment, or specialty inspection";
  if (/^8[A-Z]$/.test(key)) return "Administrative or program (DOB)";
  if (/^9[A-Z]$/.test(key)) return "Other DOB program category";

  if (/^\d{2}$/.test(key)) return `DOB category ${key}`;

  return `DOB category ${key}`;
}
