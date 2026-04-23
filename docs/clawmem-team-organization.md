# ClawMem 团队组织图

下面这张图用于说明在一个 `ClawMem Org` 内，如何把 GitHub 业务仓、团队级记忆仓，以及 agent 私有记忆仓组织在一起。

```mermaid
flowchart LR
    classDef org fill:#0b5d7a,color:#ffffff,stroke:#083d52,stroke-width:1px;
    classDef team fill:#2a9d8f,color:#ffffff,stroke:#1f6f67,stroke-width:1px;
    classDef code fill:#eef6f8,color:#1f2937,stroke:#8db7c2,stroke-width:1px;
    classDef shared fill:#7b6d8d,color:#ffffff,stroke:#5a4f68,stroke-width:1px;
    classDef private fill:#d95d39,color:#ffffff,stroke:#9f3f21,stroke-width:1px;
    classDef agent fill:#e9c46a,color:#1f2937,stroke:#a36d00,stroke-width:1px;
    classDef cross fill:#f4a261,color:#1f2937,stroke:#b85c00,stroke-width:1px;

    PrivateRepos["10 x Agent Private Repos<br/>每个 agent 各自持有对话 / 私有记忆 / 临时工作上下文"]:::private

    subgraph AgentLayer["ClawMem Agents"]
        direction TB
        A01["agent-01<br/>cluster control plane"]:::agent
        A02["agent-02<br/>cluster runtime"]:::agent
        A03["agent-03<br/>dataflow core"]:::agent
        A04["agent-04<br/>frontend experience"]:::agent
        A05["agent-05<br/>storage engine core"]:::agent
        A06["agent-06<br/>storage integration"]:::agent
        A07["agent-07<br/>shared delivery"]:::cross
        A08["agent-08<br/>api contract"]:::cross
        A09["agent-09<br/>infra-storage bridge"]:::cross
        A10["agent-10<br/>org memory steward"]:::cross
    end

    subgraph OrgLayer["ClawMem Org"]
        direction TB
        OrgRepos["Org-level ClawMem repos<br/>组织级共享规则 / 标准 / 非 team 业务记忆"]:::org

        subgraph TeamLayer["ClawMem Teams"]
            direction TB
            ClusterTeam["cluster-service team<br/>team clawmem repo<br/>- rules memory<br/>- scope memory"]:::team
            DataflowTeam["dataflow team<br/>team clawmem repo<br/>- rules memory<br/>- scope memory"]:::team
            FrontendTeam["frontend team<br/>team clawmem repo<br/>- rules memory<br/>- scope memory"]:::team
            StorageTeam["storage team<br/>team clawmem repo<br/>- rules memory<br/>- scope memory"]:::team
        end
    end

    subgraph GitHubLayer["GitHub Business Repos"]
        direction TB
        ClusterRepos["cluster-service team repos<br/>tidb-management-service<br/>cluster-service-ng<br/>serverless-service<br/>infra-provider<br/>aws-shared-provider<br/>api-gateway"]:::code
        DataflowRepos["dataflow team repos<br/>dataflow-service"]:::code
        FrontendRepos["frontend team repos<br/>dbaas-ui"]:::code
        StorageRepos["storage team repos<br/>cloud-storage-engine<br/>tidb-cse<br/>tiflash-cse<br/>client-go-cse"]:::code
        SharedCD["shared repo<br/>aws-shared-cd"]:::shared
    end

    PrivateRepos -. "1:1 private repo" .-> A01
    PrivateRepos -. "1:1 private repo" .-> A02
    PrivateRepos -. "1:1 private repo" .-> A03
    PrivateRepos -. "1:1 private repo" .-> A04
    PrivateRepos -. "1:1 private repo" .-> A05
    PrivateRepos -. "1:1 private repo" .-> A06
    PrivateRepos -. "1:1 private repo" .-> A07
    PrivateRepos -. "1:1 private repo" .-> A08
    PrivateRepos -. "1:1 private repo" .-> A09
    PrivateRepos -. "1:1 private repo" .-> A10

    A01 -->|"primary"| ClusterTeam
    A02 -->|"primary"| ClusterTeam
    A03 -->|"primary"| DataflowTeam
    A04 -->|"primary"| FrontendTeam
    A05 -->|"primary"| StorageTeam
    A06 -->|"primary"| StorageTeam
    A07 -->|"primary"| ClusterTeam
    A07 -. "shared delivery" .-> DataflowTeam
    A08 -->|"primary"| FrontendTeam
    A08 -. "shared api contract" .-> ClusterTeam
    A09 -->|"primary"| StorageTeam
    A09 -. "infra / storage bridge" .-> ClusterTeam
    A10 -->|"primary"| OrgRepos
    A10 -. "org memory policy" .-> ClusterTeam
    A10 -. "org memory policy" .-> DataflowTeam
    A10 -. "org memory policy" .-> FrontendTeam
    A10 -. "org memory policy" .-> StorageTeam

    ClusterTeam -->|"团队规则 / 领域记忆支撑"| ClusterRepos
    DataflowTeam -->|"团队规则 / 领域记忆支撑"| DataflowRepos
    FrontendTeam -->|"团队规则 / 领域记忆支撑"| FrontendRepos
    StorageTeam -->|"团队规则 / 领域记忆支撑"| StorageRepos

    ClusterTeam -. "shared repo" .-> SharedCD
    DataflowTeam -. "shared repo" .-> SharedCD

    ClusterTeam -->|"跨团队可复用记忆上收"| OrgRepos
    DataflowTeam -->|"跨团队可复用记忆上收"| OrgRepos
    FrontendTeam -->|"跨团队可复用记忆上收"| OrgRepos
    StorageTeam -->|"跨团队可复用记忆上收"| OrgRepos

    OrgRepos -. "组织级规则下发 / 全局适用" .-> ClusterTeam
    OrgRepos -. "组织级规则下发 / 全局适用" .-> DataflowTeam
    OrgRepos -. "组织级规则下发 / 全局适用" .-> FrontendTeam
    OrgRepos -. "组织级规则下发 / 全局适用" .-> StorageTeam
```

## 图示说明

- 每个 `team clawmem repo` 都承载团队级长期记忆，至少包含两类内容：`rules memory` 和 `scope memory`。
- `rules memory` 用来记录团队内的 agent 职责、路由规则、ownership 等约定。
- `scope memory` 用来标记该团队负责的业务领域、服务边界、系统范围等知识。
- 每个 agent 保留自己的 `private repo`，优先存储私有对话、临时上下文和个人工作记忆，只有在需要共享时才向 team repo 沉淀。
- 图里的实线表示 `primary` 主归属，虚线表示 `cross-team` 共享职责，所以部分 agent 会同时服务多个 team。
- `aws-shared-cd` 被单独画为共享仓，因为它同时服务于 `cluster-service team` 和 `dataflow team`。
- `org-level clawmem repos` 用于沉淀整个组织范围都需要遵循或复用的记忆，而不是某一个 team 独有的业务记忆。

## 10 个 agent 的 team / cross-team 分工建议

这里不再把 10 个 agent 简单理解成完全按 team 切开的 `4 + 2 + 1 + 3`，而是采用：

- 每个 agent 都有一个 `primary home`
- 部分 agent 通过 `cross-team` 方式服务多个 team
- `org` 维度单独保留 1 个治理型 agent

建议的 agent 编组如下：

| Agent | Primary Home | Cross-team 支持 | 主要职责 | 主要对应 repo |
| --- | --- | --- | --- |
| agent-01 | cluster-service team | 无 | cluster control plane，负责集群生命周期与管理面核心逻辑 | tidb-management-service，cluster-service-ng |
| agent-02 | cluster-service team | 无 | cluster runtime，负责 serverless、provider、runtime 侧能力 | serverless-service，infra-provider，aws-shared-provider |
| agent-03 | dataflow team | 无 | dataflow core，负责数据流主业务和 team 领域记忆 | dataflow-service，team clawmem repo |
| agent-04 | frontend team | 无 | frontend experience，负责 UI 实现、交互约定、前端领域知识 | dbaas-ui，team clawmem repo |
| agent-05 | storage team | 无 | storage engine core，负责核心存储引擎能力与领域记忆 | cloud-storage-engine，team clawmem repo |
| agent-06 | storage team | 无 | storage integration，负责 TiDB / SDK 接入与 client 协同 | tidb-cse，client-go-cse |
| agent-07 | cluster-service team | dataflow team | shared delivery，负责 `aws-shared-cd` 及 cluster/dataflow 交付协作 | aws-shared-cd |
| agent-08 | frontend team | cluster-service team | api contract，负责前后端接口契约、gateway 协作和流程对齐 | dbaas-ui，api-gateway |
| agent-09 | storage team | cluster-service team | infra-storage bridge，负责基础设施与存储侧的 provision / integration 协同 | tiflash-cse，infra-provider，aws-shared-provider |
| agent-10 | org | cluster-service team，dataflow team，frontend team，storage team | org memory steward，负责 org-level rules、记忆治理、跨 team 标准收敛 | org-level clawmem repos，team clawmem repos |

## 补充建议

- `agent-07`、`agent-08`、`agent-09`、`agent-10` 是图里的跨 team agent，分别承接 shared delivery、api contract、infra bridge、org governance 四类横向能力。
- 这样设计后，team 仍然是记忆沉淀和业务 ownership 的主边界，但 agent 不会被强行限制成只能服务单一 team。
- 如果后续横向协作继续变重，可以把 `shared delivery`、`api contract`、`org memory governance` 进一步抽成独立 platform team。
