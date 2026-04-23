# ClawMem Team Agent Workflow

下面这张图用于说明在 ClawMem org/team 结构下，一个 agent 如何从任务入口开始，按需召回不同 memory repo 中的记忆，并在任务完成后把新的长期记忆沉淀回合适的 repo。

组织结构背景见 [ClawMem 团队组织图](./clawmem-team-organization.md)。

```mermaid
flowchart TD
    classDef agent fill:#e9c46a,color:#1f2937,stroke:#a36d00,stroke-width:1px;
    classDef repo fill:#eef6f8,color:#1f2937,stroke:#8db7c2,stroke-width:1px;
    classDef team fill:#2a9d8f,color:#ffffff,stroke:#1f6f67,stroke-width:1px;
    classDef org fill:#0b5d7a,color:#ffffff,stroke:#083d52,stroke-width:1px;
    classDef decision fill:#f4a261,color:#1f2937,stroke:#b85c00,stroke-width:1px;
    classDef work fill:#f6f1df,color:#1f2937,stroke:#c0a96b,stroke-width:1px;
    classDef output fill:#d95d39,color:#ffffff,stroke:#9f3f21,stroke-width:1px;

    subgraph Access["1. Agent identity and repo access"]
        direction LR
        Agent["Agent<br/>拥有自己的 identity / token"]:::agent
        PrivateRepo["Agent private repo<br/>私有对话 / 私有记忆 / 临时上下文"]:::repo
        TeamMemoryRepos["Team memory repos<br/>cluster / dataflow / frontend / storage"]:::team
        OrgMemoryRepos["Org-level memory repos<br/>全局规则 / 标准 / 跨 team 记忆"]:::org
        CrossTeamRepos["Authorized cross-team repos<br/>agent 被授权访问的其他 team repo"]:::team

        Agent -. "default private memory space" .-> PrivateRepo
        Agent -. "team membership" .-> TeamMemoryRepos
        Agent -. "org permission" .-> OrgMemoryRepos
        Agent -. "explicit authorization" .-> CrossTeamRepos
    end

    subgraph Intake["2. Task intake"]
        direction LR
        UserTask["用户直接给任务"]:::work
        TaskMemory["从 team memory repo<br/>召回 kind:task memory"]:::work
    end

    UserTask --> TaskInbox["Agent task inbox<br/>形成当前任务"]:::agent
    TaskMemory --> TaskInbox

    TaskInbox --> RouteRecall{"判断需要召回哪些记忆？<br/>repo + optional kind/topic"}:::decision

    RouteRecall -->|"repo: private / team / org / cross-team<br/>kind: optional<br/>topic: optional"| Recall["Memory recall<br/>按 repo 和 label 条件检索"]:::work

    PrivateRepo -. "recall source" .-> Recall
    TeamMemoryRepos -. "recall source" .-> Recall
    OrgMemoryRepos -. "recall source" .-> Recall
    CrossTeamRepos -. "recall source" .-> Recall

    Recall --> InjectPrompt["把相关 memory 注入 prompt/context"]:::work
    InjectPrompt --> LLMWork["Agent + LLM 执行任务<br/>读代码 / 改代码 / 调工具 / 产出结果"]:::agent
    LLMWork --> NeedMore{"任务过程中还需要更多记忆？"}:::decision
    NeedMore -->|"是"| RouteRecall
    NeedMore -->|"否"| Finish["完成当前任务"]:::output

    Finish --> Summarize{"是否有可沉淀的长期记忆？"}:::decision
    Summarize -->|"否"| Close["关闭任务<br/>仅保留 private conversation"]:::output
    Summarize -->|"是"| RouteStore{"判断沉淀到哪里？<br/>target repo + labels"}:::decision

    RouteStore -->|"private fact / personal context"| StorePrivate["写入 agent private repo"]:::repo
    RouteStore -->|"team business memory"| StoreTeam["写入对应 team memory repo"]:::team
    RouteStore -->|"org-wide rule / standard"| StoreOrg["写入 org-level memory repo"]:::org
    RouteStore -->|"cross-team reusable memory"| StoreCrossTeam["写入被授权的 cross-team repo"]:::team

    StorePrivate --> Labels["应用 labels<br/>type:memory<br/>kind:* optional<br/>topic:* optional"]:::work
    StoreTeam --> Labels
    StoreOrg --> Labels
    StoreCrossTeam --> Labels
    Labels --> Done["新记忆可被后续 agent 召回"]:::output
```

## 读图方式

- `Agent private repo` 是 agent 的默认私有记忆空间，适合保存个人对话、临时上下文和不需要团队共享的记忆。
- `Team memory repos` 是 team 的长期共享记忆空间，适合保存业务领域知识、`kind:task`、`kind:rule`、`kind:scope` 等团队可复用内容。
- `Org-level memory repos` 保存全组织都适用的规则、标准、流程和跨 team 共识。
- `Cross-team repos` 表示 agent 被显式授权访问的其他 team memory repo，用来支持 shared delivery、API contract、infra bridge 等跨 team 工作。
- 召回和沉淀都要先做 routing 判断：选择哪个 memory repo，以及是否需要附加 `kind:*`、`topic:*` 等 label 条件。
- `kind` 和 `topic` 都是可选条件；没有明确分类时，agent 也可以只按 repo 范围和语义相关性召回或沉淀。
