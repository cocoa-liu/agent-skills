# SGLang-Omni 迁移案例

适用：当前仓库为 SGLang-Omni，或需要理解这三个 PR 的经验。以下为合并时的历史事实；先核对当前 checkout 和依赖版本。路径是定位线索，不是所有模型必须遵守的目录结构。

资料依据：本轮设计前已核对的三个 PR 最终补丁和评审讨论（2026-09）。PR 描述可能落后于补丁；代码事实以最终 diff 为准，评测数字属于作者报告，不是当前任务的实测。

## #1725：Voxtral TTS，接回共享设备解析与 layout 修复

来源：[PR #1725](https://github.com/sgl-project/sglang-omni/pull/1725)。

- **入口线索：** models/voxtral_tts/pipeline/stages.py，generation/vocoder 工厂；audio_tokenizer.py 的 attention。
- **问题与原契约：** 默认 CUDA 设备阻碍 NPU 放置；工厂不能覆盖用户显式 device，设备选择应遵循共享 builder。attention 输出可能非连续，而后续展平不能依赖特定 stride。
- **最终修复：** 两个工厂默认 device=None；generation 保留参数交给共享 builder；vocoder 使用 resolve_device_spec(device, gpu_id)。audio_tokenizer 中相关 output.view 改为 output.reshape。
- **验证：** 工厂参数透传、显式设备保持、vocoder 解析与 attention 输出测试；作者报告了单 NPU 真实权重/全量 SeedTTS 评测。当前迁移仍须运行自己的验收。
- **边界：** reshape 能处理不满足 view 条件的布局，但可能复制；不能据此全局替换所有 view，也不能假设涉及别名/原地更新时等价。
- **范围教训：** 评审后删除 TP plumbing、分 rank heads 和分布式初始化扩展；单设备需求无需预先开发多卡。

评审：
- [保留共享设备放置语义](https://github.com/sgl-project/sglang-omni/pull/1725#discussion_r3915282167)
- [将任务收敛到单 NPU](https://github.com/sgl-project/sglang-omni/pull/1725#discussion_r3912403959)

## #1691：FishAudio S2-Pro，复用后端和音频路径

来源：[PR #1691](https://github.com/sgl-project/sglang-omni/pull/1691)。

- **设备缺口：** config 中固定设备会抢先决定 accelerator 0，妨碍 launcher 放置。最终移除固定 device，factory 接收 gpu_id，并将其与 device 交给 builder。
- **算子缺口：** 最终 Fast-AR 单 token 路径使用已有 torch.ops.npu.npu_fused_infer_attention_score，局部 wrapper 负责 KV 写入、有效缓存范围、BSND layout、head 数与 scale；没有自行开发 NPU kernel。PR 描述中的 SDPA fallback 不是最终代码，不能直接复制。
- **图执行：** 合并版设置 NPU graph decode 和有界 bucket，相关配置意在规避当时 ascend eager 并发内容问题及内存压力。具体 batch 上限、内存比例和 dtype 都是该模型/环境策略，不能成为通用默认值。
- **音频缺口：** 参考音频路径改用共享 load_audio(..., target_sample_rate=codec.sample_rate, mono=True)，经过平台重采样策略；TorchCodec 不可用时的 SoundFile fallback 放在共享加载实现，删除重复 helper。
- **能力归属：** 架构级 supports_torch_compile 保持原契约，NPU 默认关闭策略放运行配置/执行层，不在 import 时改成全局 false。
- **验证侧重：** 实际非零逻辑设备、不同采样率参考音频、KV cache 语义、并发内容正确性、流式输出，以及真实环境 graph 路径。mock 只能证明 wrapper/派发，不能证明 fused 算子的数值正确性。

评审：
- [避免配置提前固定设备](https://github.com/sgl-project/sglang-omni/pull/1691#discussion_r3925399484)
- [复用含重采样的共享音频加载](https://github.com/sgl-project/sglang-omni/pull/1691#discussion_r3925399331)
- [测试替身符合真实 resolver](https://github.com/sgl-project/sglang-omni/pull/1691#discussion_r3925399761)
- [删除失去真实调用者的 helper 和测试](https://github.com/sgl-project/sglang-omni/pull/1691#discussion_r3931220280)
- [区分架构能力和平台运行策略](https://github.com/sgl-project/sglang-omni/pull/1691#discussion_r3931475313)

## #1476：Qwen3-Omni talker，扩展正确的公共边界

来源：[PR #1476](https://github.com/sgl-project/sglang-omni/pull/1476)。

- **运行时 API：** stream/event 等复用通用设备 API。scheduler 已有实际 device 时，以 torch.get_device_module(self._device) 选择模块，避免 CPU stage 错用进程默认 accelerator。
- **传输：** 现有平台接口增加 get_intra_node_transport；CUDA 选择 CUDA_IPC，基础实现选择 SHM。direct IPC 快捷路径也检查平台策略，避免绕过分派。
- **导入和策略：** fused_qk_norm_rope 的 CUDA 导入移入 CUDA 平台方法；不支持时由已有非 fused 路径承担。CUDA backend policy 移到 CUDA 层，共享不变量仍留 ModelWorker。
- **graph 边界：** 独立 Code2Wav runner 当时仍是 CUDA graph 实现，NPU 明确关闭该组件 graph，没有把 CUDAGraph 方法名机械换到 torch.npu 下。
- **验证侧重：** CPU stage 在 accelerator 主机上的正确设备选择、IPC 快捷路径、CUDA 专属导入隔离、公共 EP 限制和 CUDA policy 测试的实际 lookup 位置。
- **限制：** 当时 SGLang 的兼容替换可能影响 tensor.is_cuda。根据当前环境核对，不推广成所有 NPU tensor 的属性。

评审：
- [IPC 快捷路径也要服从平台策略](https://github.com/sgl-project/sglang-omni/pull/1476#discussion_r3759865995)
- [按配置设备选择 device module](https://github.com/sgl-project/sglang-omni/pull/1476#discussion_r3759924541)
- [graph 支持边界](https://github.com/sgl-project/sglang-omni/pull/1476#discussion_r3759931322)
- [共享不变量归属](https://github.com/sgl-project/sglang-omni/pull/1476#discussion_r3759900949)

这些案例支持的是“找到已有能力并保持契约”。不能推出“NPU 永远要开 graph”“永远要关 graph”或“共享层永远不能改”。案例中的框架修改不构成本次授权；当前任务仍须按第 3 节取得用户批准。

## 2026-09-10 回放补充：哪些证据会改变判断

以下是早期阶段记录，后续主任务已有进一步排查；这些配置与数值不是当前最终候选的验收结论，不应作为新模型的默认修复。维护备用包时未重跑模型，未将尚未结束的排查写成已验证经验。

- Voxtral 的英语 WER 把弯引号缩写误拆成多个词。对全部参考和转写先统一 U+2018/U+2019，再复用 Whisper normalizer，可以修正计数；额外读出的词仍应计错。统一评分后两轮净差仍为14个词，不能把评分修复当成生成回归的完整解释。
- Fish 的一次1088条运行全部返回有效音频，但原协议WER为18.19%；“请求成功”与“内容正确”必须分别看。定位时对齐参考音频条件，避免同时改变是否克隆与并发后作单因果结论。
- Qwen 同步decode的32条并发探针成功，完整运行仍在666条后失败；单独关闭异步不是已证实修复。对于会清理批次的共享方法，应区分可执行batch与仅含结果字段的snapshot，不能仅凭二者有同名方法就直接复用。

这些是已知案例的运行证据，不是为每次迁移新增固定测试矩阵。完整实验、失败尝试和后续配置验收由该次迁移报告承载。

后续完整验收：Fish 在同一 NPU 上复用独立 vocoder process，并设置 tts_engine/vocoder 显存预算为 0.75/0.15，保留 graph 和 AR 容量16；相同1088条无参考音频、客户端并发16的原协议WER降至1.323%，仍有2条WER>50%。这验证了运行配置的效果，没有唯一证明底层竞态根因。Qwen 使用原生配置将 thinker/talker 容量各设为4、同步decode，客户端并发16完成1088条生成和转写，原协议WER2.478%；属于已验证规避，有排队延迟代价。不要将这些参数推广为其他模型的默认值。
