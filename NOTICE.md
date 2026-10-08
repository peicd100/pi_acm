# Provenance and third-party notices

This repository packages the maintainer's local `pi-acm-passive-v1.4.0`
implementation. Runtime files in `extensions/`, `src/`, and `policy.json`
were copied without behavior changes; tests were copied with portable SDK
resolution replacing machine-specific paths.

The existing local distribution did not include a LICENSE file. Its complete
upstream provenance has not been independently established. The separate npm
package `pi-acm@0.3.12` declares MIT, but that alone does not establish the
license or attribution requirements of this passive implementation. Before
public release, the maintainer must check any reused code and preserve all
required upstream copyright/license notices.

Runtime dependency: `gpt-tokenizer@3.4.0` (MIT, as declared by that package).
Pi host APIs are provided by the user's Pi installation, not shipped as
runtime dependencies. Pi packages used for development retain their own
licenses and are not part of the production Git dependency install.
