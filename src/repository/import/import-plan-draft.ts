import { createImportPlan, createMaterializationIntent } from "./import-plan-compile.ts";
import { prepareImportPlan } from "./import-plan-prepare.ts";

import type { RepositoryBackend } from "../../backend/types.ts";
import type { V2GitServiceTransport } from "../../transport/client/upload-pack/types.ts";
import type { RefAdvertisement } from "../../transport/protocol/types.ts";
import type { ImportMaterializationIntent } from "./import-plan-types.ts";
import type {
  BranchMaterializationOptions,
  HeadMaterializationOptions,
  ImportPlanDraft,
  ImportView,
  NamespaceMaterializationOptions,
  RefMaterializationDraft,
  TagMaterializationOptions,
} from "./import-session-types.ts";

export function createImportPlanDraft(
  backend: RepositoryBackend,
  advertisement: Readonly<RefAdvertisement>,
  v2Transport?: V2GitServiceTransport,
): ImportPlanDraft {
  const actions: ImportMaterializationIntent[] = [];

  const draft: ImportPlanDraft = {
    materialize(view: ImportView): RefMaterializationDraft {
      return {
        toNamespace(
          targetPattern: string,
          options?: NamespaceMaterializationOptions,
        ): ImportPlanDraft {
          actions.push(
            createMaterializationIntent(view, "namespace", targetPattern, options?.policy, {
              prune: options?.prune,
            }),
          );
          return draft;
        },

        toBranch(branchName: string, options?: BranchMaterializationOptions): ImportPlanDraft {
          actions.push(
            createMaterializationIntent(
              view,
              "branch",
              branchName,
              options?.policy ?? { mode: "fast-forward" },
            ),
          );
          return draft;
        },

        toTag(tagName: string, options?: TagMaterializationOptions): ImportPlanDraft {
          actions.push(
            createMaterializationIntent(
              view,
              "tag",
              tagName,
              options?.policy ?? { mode: "create-only" },
            ),
          );
          return draft;
        },

        setHead(options?: HeadMaterializationOptions): ImportPlanDraft {
          actions.push(
            createMaterializationIntent(
              view,
              "head",
              "HEAD",
              { mode: "replace" },
              {
                detach: options?.detach,
              },
            ),
          );
          return draft;
        },
      };
    },

    build() {
      const snapshot = actions.map((action) => ({ ...action }));
      return createImportPlan(backend, advertisement, v2Transport, snapshot, prepareImportPlan);
    },
  };

  return draft;
}
