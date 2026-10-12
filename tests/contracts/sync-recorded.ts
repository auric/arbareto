// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Real stdout of Git 2.56.0.windows.2 on the T002 fixtures (buildFetchFlags, buildPull, buildHooks, buildPush), recorded on 2026-10-12.
// Each push output had the local fixture path in its `To` line. The record replaces it with `<url>`. No parser reads that URL.

export const RECORDED_GIT = "2.56.0.windows.2";

// Key: the recorded command. Value: exit code and stdout.
export const RECORDED: Record<string, { exit: number; stdout: string }> = {
  "fetch.d3": { exit: 0, stdout: "  c53b5b9004fb3ec22e81c45a3966ff316fbf09cc 660748b661ff79d292b6ac4e42f1bee02378c32c refs/remotes/origin/ff\n+ cf1e41cac6b4b4215a7bb98b2a287c15fa9a9e07 638c9c9dee09215140ef08172b3169b34608a05d refs/remotes/origin/forced\n* 0000000000000000000000000000000000000000 5a51beaf756855fe8d703bbc0058961e2dd9679d refs/remotes/origin/new\n+ 77d2061740846f7b9b60a7571eb339ffab3a2dd3 f192ef71474c068e65c29a359bced615cae1537c refs/remotes/origin/rewound\n" },
  "fetch.prune-tags-force": { exit: 0, stdout: "- c53b5b9004fb3ec22e81c45a3966ff316fbf09cc 0000000000000000000000000000000000000000 refs/remotes/origin/gone-soon\n  c53b5b9004fb3ec22e81c45a3966ff316fbf09cc 660748b661ff79d292b6ac4e42f1bee02378c32c refs/remotes/origin/ff\n+ cf1e41cac6b4b4215a7bb98b2a287c15fa9a9e07 638c9c9dee09215140ef08172b3169b34608a05d refs/remotes/origin/forced\n* 0000000000000000000000000000000000000000 5a51beaf756855fe8d703bbc0058961e2dd9679d refs/remotes/origin/new\n+ 77d2061740846f7b9b60a7571eb339ffab3a2dd3 f192ef71474c068e65c29a359bced615cae1537c refs/remotes/origin/rewound\nt c53b5b9004fb3ec22e81c45a3966ff316fbf09cc 660748b661ff79d292b6ac4e42f1bee02378c32c refs/tags/t1\n" },
  "fetch.rewound": { exit: 1, stdout: "! 77d2061740846f7b9b60a7571eb339ffab3a2dd3 f192ef71474c068e65c29a359bced615cae1537c refs/remotes/origin/rewound\n" },
  "fetch.up-to-date-verbose": { exit: 0, stdout: "= c53b5b9004fb3ec22e81c45a3966ff316fbf09cc c53b5b9004fb3ec22e81c45a3966ff316fbf09cc refs/remotes/origin/main\n= 660748b661ff79d292b6ac4e42f1bee02378c32c 660748b661ff79d292b6ac4e42f1bee02378c32c refs/remotes/origin/ff\n= 638c9c9dee09215140ef08172b3169b34608a05d 638c9c9dee09215140ef08172b3169b34608a05d refs/remotes/origin/forced\n= 5a51beaf756855fe8d703bbc0058961e2dd9679d 5a51beaf756855fe8d703bbc0058961e2dd9679d refs/remotes/origin/new\n= f192ef71474c068e65c29a359bced615cae1537c f192ef71474c068e65c29a359bced615cae1537c refs/remotes/origin/rewound\n" },
  "push.created": { exit: 0, stdout: "To <url>\n*\trefs/heads/p-equal:refs/heads/created\t[new branch]\nDone\n" },
  "push.up-to-date": { exit: 0, stdout: "To <url>\n=\trefs/heads/p-equal:refs/heads/created\t[up to date]\nDone\n" },
  "push.rejected": { exit: 1, stdout: "To <url>\n!\trefs/heads/p-diverged:refs/heads/p-diverged\t[rejected] (non-fast-forward)\nDone\n" },
  "push.remote-rejected": { exit: 1, stdout: "To <url>\n!\trefs/heads/p-equal:refs/heads/x\t[remote rejected] (pre-receive hook declined)\nDone\n" },
  "push.lease-rejected": { exit: 1, stdout: "To <url>\n!\trefs/heads/p-diverged:refs/heads/p-diverged\t[rejected] (stale info)\nDone\n" },
  "push.forced": { exit: 0, stdout: "To <url>\n+\trefs/heads/p-diverged:refs/heads/p-diverged\tb8481fb...eccb559 (forced update)\nDone\n" },
  "push.fast-forward": { exit: 0, stdout: "To <url>\n \trefs/heads/p-behind:refs/heads/p-equal\tc53b5b9..bbf1b24\nDone\n" },
  "tracking": { exit: 0, stdout: "refs/heads/main\u0000c53b5b9004fb3ec22e81c45a3966ff316fbf09cc\u0000refs/remotes/origin/main\u0000\u0000*\nrefs/heads/p-behind\u0000bbf1b244faad7c21296a5274dd2e24d9a46ca12b\u0000refs/remotes/origin/p-behind\u0000\u0000 \nrefs/heads/p-diverged\u0000eccb5595dfdb31d77b6b63703720c5b54194a2ac\u0000refs/remotes/origin/p-diverged\u0000ahead 1, behind 1\u0000 \nrefs/heads/p-equal\u0000c53b5b9004fb3ec22e81c45a3966ff316fbf09cc\u0000refs/remotes/origin/p-equal\u0000\u0000 \nrefs/heads/rewrite\u00007af04eb869d5507a766d0df9a6407dfe5f0868a9\u0000refs/remotes/origin/rewrite\u0000ahead 1\u0000 \nrefs/remotes/origin/HEAD\u0000c53b5b9004fb3ec22e81c45a3966ff316fbf09cc\u0000\u0000\u0000 \nrefs/remotes/origin/main\u0000c53b5b9004fb3ec22e81c45a3966ff316fbf09cc\u0000\u0000\u0000 \nrefs/remotes/origin/p-behind\u0000bbf1b244faad7c21296a5274dd2e24d9a46ca12b\u0000\u0000\u0000 \nrefs/remotes/origin/p-diverged\u0000b8481fb7912c87754fa5f3baa1f5c684a99d0a8d\u0000\u0000\u0000 \nrefs/remotes/origin/p-equal\u0000c53b5b9004fb3ec22e81c45a3966ff316fbf09cc\u0000\u0000\u0000 \nrefs/remotes/origin/rewrite\u00001488cccf42680f79afa72de87baf6cc5dce18433\u0000\u0000\u0000 \n" },
  "ahead-behind.rewrite": { exit: 0, stdout: "1\t0\n" },
  "lease-count": { exit: 0, stdout: "1\n" },
  "push-record.push.default=unset/topic": { exit: 0, stdout: "refs/heads/topic\u000052a6d3a287f8fa3569f774c9d80e0740da0f5867\u0000refs/remotes/origin/topic\u0000origin\u0000refs/heads/topic\u0000refs/remotes/origin/topic\u0000origin\u0000\n" },
  "push-record.push.default=current/noup": { exit: 0, stdout: "refs/heads/noup\u00001802ee73c05efc344bbee781e52792928efd106e\u0000\u0000\u0000\u0000refs/remotes/origin/noup\u0000\u0000\n" },
  "push-record.remote.origin.push/renamed": { exit: 0, stdout: "refs/heads/renamed\u000045cd7a31a4d8308b07d138dfa34e08b289a7dd3e\u0000refs/remotes/origin/other-name\u0000origin\u0000refs/heads/other-name\u0000refs/remotes/origin/mapped\u0000origin\u0000refs/heads/mapped\n" },
  "push-record.branch.pushRemote/topic": { exit: 0, stdout: "refs/heads/topic\u000052a6d3a287f8fa3569f774c9d80e0740da0f5867\u0000refs/remotes/origin/topic\u0000origin\u0000refs/heads/topic\u0000\u0000second\u0000\n" },
  "push-record.push.default=upstream/renamed": { exit: 0, stdout: "refs/heads/renamed\u000045cd7a31a4d8308b07d138dfa34e08b289a7dd3e\u0000refs/remotes/origin/other-name\u0000origin\u0000refs/heads/other-name\u0000refs/remotes/origin/other-name\u0000origin\u0000\n" },
};
