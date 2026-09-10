# actions
GitHub actions I use for CI.

## `cache-mode`

The reusable workflows declare a least-privilege [`cache-mode`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode) on each job.

- `node`, `node-majors`, `node-esm`, `browser`, and `bun`: test jobs declare `read`, so callers must not set `cache-mode` to `none` or `write-only` on the calling job or workflow — the run would fail validation. Callers that pass `build-output-dir` must also not cap at `read`: the `build` job relies on the trigger's default (`write`) to save the build output.
- `pretest` and `rebase`: every job declares `none`, which is compatible with any caller setting.
