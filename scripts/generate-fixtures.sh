#!/usr/bin/env bash
# Export XML fixtures from local .trace files for a given Xcode version.
#
# Usage:
#   ./scripts/generate-fixtures.sh <xcode-version> <trace-dir>
#
# Example:
#   ./scripts/generate-fixtures.sh 27.0 ~/Documents/traces
#
# The generated XML files land in tests/fixtures/xcode-<version>/{schema-table,track-detail}/
# After running, review the output for any sensitive data (prompts, process names,
# IP addresses) and replace with synthetic rows before committing.
# Then run: npm test -- -u   to regenerate the snapshot file.
#
# NOTE: Some fixtures in xcode-27.0/ are SYNTHETIC (real data contained app-specific
# content). Do not blindly overwrite them — compare carefully:
#   ModelInferenceTable, InstructionsTable, FMEventTable, SessionTable, RequestTable
#   NetworkConnectionStats
#   time-sample, Allocations__Allocations-List  (synthetic due to size)
#   swiftui-updates, swiftui-causes, swiftui-changes, swiftui-full-causes  (synthetic — private app content + multi-MB)
#   swiftui-layout-updates, swiftui-update-groups  (synthetic — private app content + 28–183 MB)
#
# Adding a new schema:
#   1. Add a call below in the appropriate section.
#   2. Run this script.
#   3. Review for sensitive content, sanitize if needed.
#   4. npm test -- -u
#   5. Commit the fixture XML and the updated .snap file.

set -euo pipefail

XCODE_VERSION="${1:?Usage: $0 <xcode-version> <trace-dir>}"
TRACE_DIR="${2:?Usage: $0 <xcode-version> <trace-dir>}"
OUT="tests/fixtures/xcode-${XCODE_VERSION}"

mkdir -p "${OUT}/schema-table" "${OUT}/track-detail"

export_schema_table() {
  local trace="$1" schema="$2" run="${3:-1}"
  local out_file="${OUT}/schema-table/${schema}.xml"
  echo "  schema-table: ${schema} → ${out_file}"
  xcrun xctrace export \
    --input "${trace}" \
    --xpath "/trace-toc/run[@number=\"${run}\"]/data/table[@schema=\"${schema}\"]" \
    2>/dev/null > "${out_file}"
}

export_track_detail() {
  local trace="$1" track_name="$2" detail_name="$3" run="${4:-1}"
  # "__" in filename encodes "/" (trackName/detailName); "-" preserves spaces
  local file_name="${track_name}__${detail_name// /-}"
  local out_file="${OUT}/track-detail/${file_name}.xml"
  echo "  track-detail: ${track_name}/${detail_name} → ${out_file}"
  xcrun xctrace export \
    --input "${trace}" \
    --xpath "/trace-toc/run[@number=\"${run}\"]/tracks/track[@name=\"${track_name}\"]/details/detail[@name=\"${detail_name}\"]" \
    2>/dev/null > "${out_file}"
}

echo "Exporting fixtures for Xcode ${XCODE_VERSION} from ${TRACE_DIR}..."

# ── Foundation Models (model.trace run 1) ─────────────────────────────────────
# WARNING: These tables capture prompt/response/instruction content. Review and
# sanitize before committing — replace real rows with synthetic equivalents.
export_schema_table "${TRACE_DIR}/model.trace" "ModelInferenceTable"
export_schema_table "${TRACE_DIR}/model.trace" "ModelLoadingTable"
export_schema_table "${TRACE_DIR}/model.trace" "SessionTable"
export_schema_table "${TRACE_DIR}/model.trace" "ToolTable"
export_schema_table "${TRACE_DIR}/model.trace" "FMEventTable"
export_schema_table "${TRACE_DIR}/model.trace" "RequestTable"
export_schema_table "${TRACE_DIR}/model.trace" "InstructionsTable"

# ── Hangs & Hitches (HangsAndHitches.trace run 1) ────────────────────────────
export_schema_table "${TRACE_DIR}/HangsAndHitches.trace" "hitches"
export_schema_table "${TRACE_DIR}/HangsAndHitches.trace" "potential-hangs"
export_schema_table "${TRACE_DIR}/HangsAndHitches.trace" "hang-risks"

# ── Network (network.trace run 1) ─────────────────────────────────────────────
# WARNING: Contains real process names and IP addresses. Sanitize before committing.
export_schema_table "${TRACE_DIR}/network.trace" "network-connection-detected"
export_schema_table "${TRACE_DIR}/network.trace" "NetworkConnectionStats"
export_schema_table "${TRACE_DIR}/network.trace" "network-connection-update"

# ── SwiftData / Core Data (SwiftData.trace run 1) ────────────────────────────
export_schema_table "${TRACE_DIR}/SwiftData.trace" "core-data-save"
export_schema_table "${TRACE_DIR}/SwiftData.trace" "core-data-fetch"
export_schema_table "${TRACE_DIR}/SwiftData.trace" "core-data-fault"
export_schema_table "${TRACE_DIR}/SwiftData.trace" "core-data-relationship-fault"

# ── Swift Concurrency (swift.trace run 1) ────────────────────────────────────
export_schema_table "${TRACE_DIR}/swift.trace" "SwiftTaskLifetime"
export_schema_table "${TRACE_DIR}/swift.trace" "SwiftTaskStateTable"
export_schema_table "${TRACE_DIR}/swift.trace" "SwiftTasksInfoTable"

# ── SwiftUI (swiftUI2.trace or similar with Layout Updates enabled) ───────────
# WARNING: All SwiftUI schemas contain private app type names and are 20 MB – 1.1 GB.
# The xcode-27.0 fixtures are all synthetic. Only commit sanitized or synthetic replacements.
# To get the real column schema, export to /tmp first and check size with wc -c.
# Large tables — review carefully before committing (all are >20 MB in practice):
# export_schema_table "${TRACE_DIR}/swiftUI2.trace" "swiftui-layout-updates"
# export_schema_table "${TRACE_DIR}/swiftUI2.trace" "swiftui-update-groups"
# export_schema_table "${TRACE_DIR}/swiftUI2.trace" "swiftui-full-causes"
# export_schema_table "${TRACE_DIR}/swiftUI.trace" "swiftui-updates"
# export_schema_table "${TRACE_DIR}/swiftUI.trace" "swiftui-causes"
# export_schema_table "${TRACE_DIR}/swiftUI.trace" "swiftui-changes"

# ── Time Profiler ─────────────────────────────────────────────────────────────
# NOTE: time-sample can be very large (7MB+). The xcode-27.0 fixture is synthetic.
# If exporting a real one, check the size first and consider using a short recording.
# time-sample appears in run 3 of modelAndTime.trace in xcode-27.0:
# export_schema_table "${TRACE_DIR}/modelAndTime.trace" "time-sample" 3

# ── track-detail fixtures ─────────────────────────────────────────────────────
export_track_detail "${TRACE_DIR}/AllocAndLeaksWithBacktraces.trace" "Leaks" "Leaks"

# NOTE: "Allocations List" is typically 50-80MB — too large to store as a fixture.
# The xcode-27.0 fixture is synthetic. Only export if you have a very short recording:
# export_track_detail "${TRACE_DIR}/Alloc.trace" "Allocations" "Allocations List"

echo ""
echo "Done. Review output for sensitive content before committing."
echo "Then run: npm test -- -u"
