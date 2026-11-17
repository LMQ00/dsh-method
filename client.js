window.__ModuleLoader__.load({
	id: "dsh-method",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		/** 右侧栏标签页的注册 id，也是标签体在槽位里的 key。 */
		const TAB_ID = "dsh-method";
		/** 标签页类型，`openTab` 按它找。 */
		const TAB_KIND = "orchestrate";
		/** 会话头部按钮的注册 id。 */
		const HEADER_ID = "orchestrate";
		/** 状态来源：轮询宿主注册的路由。 */
		const STATE_ROUTE = "api/orchestrate.state";
		/** 轮询间隔。 */
		const POLL_MS = 1000;
		/** 节点盒子尺寸与间距。 */
		const NODE_W = 180;
		const NODE_H = 56;
		const GAP_X = 80;
		const GAP_Y = 34;
		/** 节点状态到样式的映射。 */
		const STATUS_STYLE = {
			"待办": { fill: "rgba(120,120,130,0.10)", stroke: "rgba(140,140,150,0.55)", text: "rgba(160,160,170,1)" },
			"进行中": { fill: "rgba(96,150,255,0.16)", stroke: "rgba(110,165,255,0.95)", text: "#cfe0ff" },
			"完成": { fill: "rgba(80,200,140,0.18)", stroke: "rgba(90,215,150,0.95)", text: "#c8f5dc" },
			"失败": { fill: "rgba(240,110,110,0.18)", stroke: "rgba(245,120,120,0.95)", text: "#ffd4d4" },
		};

		/* ---------------- 数据 ---------------- */

		/** 插件的客户端上下文，定义会话目录怎么问。 */
		let clientCtx = null;

		/**
		 * 会话所在的项目目录：先问工作目录投影，再问会话清单里的 cwd。
		 * @param {string} sessionId 会话。
		 * @returns {string} 绝对路径；问不到就是空串。
		 */
		function projectDirOf(sessionId) {
			if (clientCtx === null || typeof sessionId !== "string" || sessionId === "") return "";
			try {
				const projected = clientCtx.sessions.binding(sessionId)?.session.projections.faceOf("workingDirectory").getSnapshot();
				if (typeof projected === "string" && projected !== "") return projected;
			} catch {
				// 没有绑定就没有投影，退到会话清单。
			}
			try {
				const listed = clientCtx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
				if (typeof listed === "string" && listed !== "") return listed;
			} catch {
				// 清单里也没有就当问不到。
			}
			return "";
		}

		/**
		 * 一个项目的状态来源：轮询路由，把结果广播给订阅者；没人订阅就停。
		 * @param {string} cwd 项目目录；空串时不该建来源。
		 * @returns {object} 订阅接口。
		 */
		function createSource(cwd) {
			let snapshot = { loading: true, error: null, data: null };
			const listeners = new Set();
			let timer = null;
			let inflight = false;

			/** 发布新快照；内容没变就不吵订阅者。 */
			function publish(next) {
				const previous = snapshot;
				if (next.error === previous.error && next.loading === previous.loading) {
					const before = previous.data;
					const after = next.data;
					if (before === after) return;
					if (before !== null && after !== null
						&& before.revision === after.revision && before.updatedAt === after.updatedAt
						&& before.enabled === after.enabled && before.stage === after.stage && before.next === after.next) return;
				}
				snapshot = next;
				for (const listener of listeners) listener();
			}

			/** 拉一次状态。 */
			async function refresh() {
				if (inflight) return;
				inflight = true;
				try {
					if (cwd === "") throw new Error("没拿到这个会话的项目目录");
					const url = STATE_ROUTE + "?cwd=" + encodeURIComponent(cwd);
					const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
					if (!response.ok) throw new Error("HTTP " + response.status);
					const data = await response.json();
					publish({ loading: false, error: null, data });
				} catch (error) {
					publish({ loading: false, error: String(error && error.message ? error.message : error), data: snapshot.data });
				} finally {
					inflight = false;
				}
			}

			/** 开始轮询。 */
			function start() {
				if (timer !== null) return;
				void refresh();
				timer = setInterval(() => void refresh(), POLL_MS);
			}

			/** 停止轮询。 */
			function stop() {
				if (timer === null) return;
				clearInterval(timer);
				timer = null;
			}

			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					if (listeners.size === 1) start();
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stop();
					};
				},
			};
		}

		/** 每个项目一条来源，键是项目目录。 */
		const sources = new Map();

		/**
		 * 取一个项目的状态来源。
		 * @param {string} cwd 项目目录。
		 * @returns {object} 状态来源。
		 */
		function sourceOf(cwd) {
			let source = sources.get(cwd);
			if (source === undefined) {
				source = createSource(cwd);
				sources.set(cwd, source);
			}
			return source;
		}

		/** 问不到目录时的空订阅：什么都不轮询。 */
		const NO_SUBSCRIPTION = () => () => {};
		/** 问不到目录时的快照。 */
		const NO_PROJECT = { loading: false, error: "没拿到这个会话的项目目录", data: null };
		const noProjectSnapshot = () => NO_PROJECT;

		/**
		 * 订阅某个会话所在项目的状态；问不到目录就不订阅，也不起轮询。
		 * @param {string} sessionId 会话。
		 * @returns {object} 当前快照。
		 */
		function useSnapshot(sessionId) {
			const cwd = projectDirOf(sessionId);
			const source = cwd === "" ? null : sourceOf(cwd);
			return react.useSyncExternalStore(
				source === null ? NO_SUBSCRIPTION : source.subscribe,
				source === null ? noProjectSnapshot : source.getSnapshot,
				source === null ? noProjectSnapshot : source.getSnapshot,
			);
		}

		/* ---------------- 布局 ---------------- */

		/**
		 * 按连线给节点分层：没有入边的在最左列，有环时按节点数收敛。
		 * @param {Array} nodes 节点。
		 * @param {Array} edges 连线。
		 * @returns {Map<string, number>} 节点 id 到列号。
		 */
		function layerOf(nodes, edges) {
			const layers = new Map();
			const outgoing = new Map();
			for (const node of nodes) {
				layers.set(node.id, 0);
				outgoing.set(node.id, []);
			}
			for (const edge of edges) {
				if (outgoing.has(edge.from)) outgoing.get(edge.from).push(edge.to);
			}
			const rounds = Math.max(1, nodes.length);
			for (let round = 0; round < rounds; round += 1) {
				let moved = false;
				for (const [from, targets] of outgoing) {
					for (const to of targets) {
						const next = layers.get(from) + 1;
						if (next > layers.get(to)) {
							layers.set(to, next);
							moved = true;
						}
					}
				}
				if (!moved) break;
			}
			return layers;
		}

		/**
		 * 算每个节点的坐标。
		 * @param {Array} nodes 节点。
		 * @param {Array} edges 连线。
		 * @returns {object} { positions, width, height }。
		 */
		function layout(nodes, edges) {
			const layers = layerOf(nodes, edges);
			const columns = new Map();
			for (const node of nodes) {
				const layer = layers.get(node.id) ?? 0;
				if (!columns.has(layer)) columns.set(layer, []);
				columns.get(layer).push(node.id);
			}
			const tallest = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
			const height = tallest * NODE_H + (tallest - 1) * GAP_Y;
			const positions = new Map();
			let width = 0;
			for (const [layer, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
				const columnHeight = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
				const offset = (height - columnHeight) / 2;
				ids.forEach((id, index) => {
					positions.set(id, {
						x: layer * (NODE_W + GAP_X),
						y: offset + index * (NODE_H + GAP_Y),
					});
				});
				width = Math.max(width, layer * (NODE_W + GAP_X) + NODE_W);
			}
			return { positions, width: Math.max(width, NODE_W), height: Math.max(height, NODE_H) };
		}

		/** 一条连线的曲线。 */
		function edgePath(from, to) {
			const x1 = from.x + NODE_W;
			const y1 = from.y + NODE_H / 2;
			const x2 = to.x;
			const y2 = to.y + NODE_H / 2;
			const mid = Math.max(40, Math.abs(x2 - x1) / 2);
			return "M " + x1 + " " + y1 + " C " + (x1 + mid) + " " + y1 + ", " + (x2 - mid) + " " + y2 + ", " + x2 + " " + y2;
		}

		/* ---------------- 样式 ---------------- */

		/** 把面板样式插进文档一次。 */
		function injectStyle() {
			if (document.getElementById("dsh-orchestrate-style") !== null) return;
			const style = document.createElement("style");
			style.id = "dsh-orchestrate-style";
			style.textContent = [
				"@keyframes dsh-orch-breathe{0%,100%{stroke-width:2;filter:drop-shadow(0 0 2px rgba(110,165,255,0.35))}50%{stroke-width:3.5;filter:drop-shadow(0 0 10px rgba(110,165,255,0.85))}}",
				"@keyframes dsh-orch-enter{from{opacity:0;transform:translateY(8px) scale(0.94)}to{opacity:1;transform:translateY(0) scale(1)}}",
				"@keyframes dsh-orch-check{from{opacity:0;transform:scale(0.5)}to{opacity:1;transform:scale(1)}}",
				".dsh-orch-node{transition:fill 420ms ease,stroke 420ms ease,color 420ms ease}",
				".dsh-orch-node[data-status='进行中']{animation:dsh-orch-breathe 2.6s ease-in-out infinite}",
				".dsh-orch-node[data-fresh='true']{animation:dsh-orch-enter 420ms ease-out both}",
				".dsh-orch-check{animation:dsh-orch-check 380ms ease-out both;transform-origin:center}",
				".dsh-orch-head{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;opacity:0.75}",
				".dsh-orch-head:hover{opacity:1;background:var(--dsw-alias-bg-l2,rgba(127,127,127,0.16))}",
				".dsh-orch-head:focus-visible{outline:2px solid var(--dsw-alias-brand,#6ea5ff);outline-offset:2px}",
				"@media (prefers-reduced-motion: reduce){.dsh-orch-node[data-status='进行中']{animation:none}.dsh-orch-node[data-fresh='true']{animation:none}.dsh-orch-check{animation:none}.dsh-orch-dot{display:none}}",
			].join("\n");
			document.head.appendChild(style);
		}

		/* ---------------- 组件 ---------------- */

		/**
		 * 流程图。
		 * @param {object} props 节点与连线。
		 * @returns {object} svg 元素。
		 */
		function Chart(props) {
			const nodes = props.nodes;
			const edges = props.edges;
			const seen = react.useRef(new Set());
			const reduced = react.useRef(
				typeof window !== "undefined" && typeof window.matchMedia === "function"
					? window.matchMedia("(prefers-reduced-motion: reduce)").matches
					: false,
			);
			const computed = layout(nodes, edges);
			const positions = computed.positions;
			const fresh = new Set();
			for (const node of nodes) {
				if (!seen.current.has(node.id)) fresh.add(node.id);
			}
			react.useEffect(() => {
				for (const node of nodes) seen.current.add(node.id);
			}, [nodes]);

			const children = [];
			edges.forEach((edge, index) => {
				const from = positions.get(edge.from);
				const to = positions.get(edge.to);
				if (from === undefined || to === undefined) return;
				const d = edgePath(from, to);
				const id = "dsh-orch-edge-" + index;
				children.push(h("path", {
					key: "path-" + index,
					id: id,
					d: d,
					fill: "none",
					stroke: "rgba(140,160,200,0.35)",
					strokeWidth: 1.5,
					strokeLinecap: "round",
				}));
				if (!reduced.current) {
					children.push(h("circle", {
						key: "dot-" + index,
						className: "dsh-orch-dot",
						r: 3,
						fill: "rgba(150,190,255,0.95)",
					}, h("animateMotion", {
						dur: "2.8s",
						repeatCount: "indefinite",
						keyPoints: "0;1",
						keyTimes: "0;1",
						calcMode: "spline",
						keySplines: "0.4 0 0.6 1",
					}, h("mpath", { href: "#" + id }))));
				}
			});

			nodes.forEach((node) => {
				const position = positions.get(node.id);
				if (position === undefined) return;
				const style = STATUS_STYLE[node.status] ?? STATUS_STYLE["待办"];
				const done = node.status === "完成";
				const title = node.title.length > 14 ? node.title.slice(0, 14) + "…" : node.title;
				children.push(h("g", {
					key: "node-" + node.id,
					transform: "translate(" + position.x + " " + position.y + ")",
					"data-status": node.status,
					"data-fresh": fresh.has(node.id) ? "true" : "false",
					className: "dsh-orch-node",
				}, [
					h("rect", {
						key: "box",
						width: NODE_W,
						height: NODE_H,
						rx: 10,
						fill: style.fill,
						stroke: style.stroke,
						strokeWidth: 1.6,
					}),
					done
						? h("text", {
							key: "check",
							className: "dsh-orch-check",
							x: 16,
							y: NODE_H / 2 + 6,
							fill: "#7ee2ac",
							fontSize: 18,
						}, "✓")
						: null,
					h("text", {
						key: "title",
						x: done ? 40 : 16,
						y: NODE_H / 2 + 5,
						fill: style.text,
						fontSize: 13,
						fontFamily: "inherit",
					}, title),
				]));
			});

			return h("svg", {
				viewBox: "0 0 " + (computed.width + 24) + " " + (computed.height + 24),
				style: { width: "100%", height: "auto", display: "block" },
				role: "img",
				"aria-label": "编排流程图",
			}, h("g", { transform: "translate(12 12)" }, children));
		}

		/**
		 * 成员清单。
		 * @param {object} props 成员数组。
		 * @returns {object} 列表元素。
		 */
		function Members(props) {
			const members = props.members ?? [];
			if (members.length === 0) return h("div", { style: { color: "var(--dsw-alias-text-secondary, #8b8b93)", fontSize: 13 } }, "还没有成员");
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				members.map((member, index) => {
					const style = STATUS_STYLE[member.status] ?? STATUS_STYLE["待办"];
					return h("div", {
						key: member.name + "-" + index,
						style: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 13 },
					}, [
						h("span", { key: "dot", style: { width: 8, height: 8, borderRadius: 4, background: style.stroke, display: "inline-block", flex: "none" } }),
						h("span", { key: "name", style: { fontWeight: 600 } }, member.name),
						h("span", { key: "role", style: { color: "var(--dsw-alias-text-secondary, #8b8b93)" } }, member.role ?? ""),
						h("span", { key: "status", style: { marginLeft: "auto", color: style.stroke } }, member.status),
					]);
				}),
			);
		}

		/** 一行说明。 */
		function Line(props) {
			return h("div", { style: { fontSize: 13, color: "var(--dsw-alias-text-secondary, #8b8b93)" } }, [
				h("span", { key: "label", style: { marginRight: 8, opacity: 0.75 } }, props.label),
				h("span", { key: "value", style: { color: "var(--dsw-alias-text-primary, #e6e6ea)", fontSize: 14 } }, props.value === "" ? "—" : props.value),
			]);
		}

		/**
		 * 标签页内容：阶段、流程图、下一步、成员。
		 * @param {object} props {sessionId}。
		 * @returns {object} 面板元素。
		 */
		function ChartPage(props) {
			const snapshot = useSnapshot(props.sessionId);
			const data = snapshot.data;
			const shell = { padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, fontFamily: "inherit" };

			if (data === null) {
				return h("div", { style: shell }, h("div", { style: { fontSize: 13, opacity: 0.75 } },
					snapshot.error === null ? "正在读取编排状态…" : "读不到状态：" + snapshot.error));
			}
			if (!data.enabled) {
				return h("div", { style: shell }, [
					h("div", { key: "title", style: { fontSize: 15, fontWeight: 600 } }, "还没开启编排"),
					h("div", { key: "hint", style: { fontSize: 13, opacity: 0.75 } }, "在对话里敲 /orchestrate 开启。"),
				]);
			}

			const nodes = data.nodes ?? [];
			const edges = data.edges ?? [];
			const chartName = (data.charts ?? []).find((chart) => chart.id === data.selectedChart);
			const done = nodes.filter((node) => node.status === "完成").length;

			return h("div", { style: shell }, [
				h("div", { key: "head", style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } }, [
					h("div", { key: "stage", style: { fontSize: 15, fontWeight: 600 } }, data.stage === "" ? "未写阶段" : data.stage),
					h("div", { key: "count", style: { marginLeft: "auto", fontSize: 12, opacity: 0.6 } },
						nodes.length === 0 ? "还没有选中图" : done + "/" + nodes.length + " 节点完成"),
				]),
				h("div", { key: "chart", style: { background: "var(--dsw-specific-sidebar-fill, rgba(255,255,255,0.03))", borderRadius: 12, padding: 12, border: "0.5px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12))", overflowX: "auto" } },
					nodes.length === 0
						? h("div", { style: { fontSize: 13, opacity: 0.7 } }, "成员还没交方案图，或者还没选中一张。")
						: h(Chart, { nodes: nodes, edges: edges })),
				h("div", { key: "meta", style: { display: "flex", gap: 24, flexWrap: "wrap" } }, [
					h(Line, { key: "next", label: "下一步", value: data.next }),
					h(Line, { key: "chart", label: "选中图", value: chartName === undefined ? (data.selectedChart ?? "") : chartName.name }),
					h(Line, { key: "cwd", label: "项目", value: data.cwd }),
				]),
				h("div", { key: "members", style: { display: "flex", flexDirection: "column", gap: 8 } }, [
					h("div", { key: "label", style: { fontSize: 13, opacity: 0.6 } }, "成员"),
					h(Members, { key: "list", members: data.members }),
				]),
			]);
		}

		/**
		 * 编排图标：三个节点连着线。
		 * @param {object} props {size}。
		 * @returns {object} svg 元素。
		 */
		function OrchestrateGlyph(props) {
			const size = props && typeof props.size === "number" ? props.size : 18;
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 20 20",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				role: "img",
				"aria-label": "编排",
			}, [
				h("rect", { key: "a", x: 2, y: 3, width: 6, height: 5, rx: 1.4 }),
				h("rect", { key: "b", x: 12, y: 3, width: 6, height: 5, rx: 1.4 }),
				h("rect", { key: "c", x: 7, y: 12, width: 6, height: 5, rx: 1.4 }),
				h("path", { key: "e1", d: "M8 5.5h4" }),
				h("path", { key: "e2", d: "M5 8v2.5h5" }),
				h("path", { key: "e3", d: "M15 8v2.5h-5" }),
			]);
		}

		/**
		 * 会话头部的编排按钮，点一下开关本会话的编排标签页。项目没开编排就不画。
		 * @param {object} props {sessionId, toggle}。
		 * @returns {object} 按钮元素。
		 */
		function HeaderButton(props) {
			const snapshot = useSnapshot(props.sessionId);
			const data = snapshot.data;
			if (data === null || data.enabled !== true) return null;
			return h("button", {
				type: "button",
				className: "dsh-orch-head",
				title: "编排",
				"aria-label": "编排",
				onClick: () => { props.toggle(); },
			}, h(OrchestrateGlyph, { size: 16 }));
		}

		/* ---------------- 注册 ---------------- */

		/**
		 * 插件入口：挂右侧栏标签页与会话头部按钮。按钮自己按项目状态决定画不画。
		 * @param {object} ctx 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			clientCtx = ctx;
			injectStyle();

			/**
			 * 头部按钮的行为：本会话的编排页开着就收起，否则打开并聚焦。
			 * @param {string} sessionId 当前会话。
			 */
			function togglePanel(sessionId) {
				const right = ctx.sidebarRight;
				// 右侧栏的 openTab / hide 都作用在屏上的会话；点的不是它就别动。
				if (right.mounted.getSnapshot() !== sessionId) return;
				const tab = right.tabsIn(sessionId).find((item) => item.kind === TAB_KIND);
				const active = right.active();
				if (tab !== undefined && right.isExpanded() && active !== undefined && active.kind === TAB_KIND) {
					right.hide(tab.id);
					return;
				}
				right.openTab(TAB_KIND);
			}

			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => "编排",
			}), "dsh-method: 右侧栏标签页");

			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
			}, ChartPage));

			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: HEADER_ID,
				order: -6,
				inject: (sessionId) => ({ toggle: () => { togglePanel(sessionId); } }),
			}, HeaderButton));
		}

		exports.ChartPage = ChartPage;
		exports.apply = apply;
		exports.inject = ["slots", "sidebarRightTabs", "sidebarRight", "sessions"];
		return module.exports;
	},
});
