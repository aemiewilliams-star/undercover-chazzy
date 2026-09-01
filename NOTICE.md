# Attribution and deployment notice

This program is a modified version of Chazzy.

- Upstream: `https://github.com/AiOO/chazzy`
- Upstream lineage: `kimcore/chzzk-overlay` → `AiOO/chazzy` → this UNDERCOVER fork
- Baseline branch: `add-chazzy`
- Baseline commit: `fcdde23dd8f748fb37117c4e27b49d831427dfe0`
- License: GNU Affero General Public License v3.0

The UNDERCOVER modifications add a dedicated YouTube collector route, Flutter bridge protocol, privacy normalizer, bounded retry and liveness reporting, queue and heartbeat contracts, restrictive CSP, collector-only deployment mode, and removal of third-party telemetry.

There is no warranty, to the extent permitted by law. Operators that let users interact with this modified program over a network must make the complete corresponding source of the version actually running available under AGPL-3.0. Before public deployment, configure a prominent source-code notice in the surrounding product or collector deployment that points to the matching public source revision. Do not point only to upstream: the published source must include these modifications and the build/deployment material required by the license.
