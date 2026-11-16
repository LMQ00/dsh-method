window.__ModuleLoader__.load({
	id: "dsh-method",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		/** 面板注册用的 id：sidebar 入口与全屏页共用。 */
		const PANEL_ID = "orchestrate";
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

		/**
		 * 一份状态来源：轮询路由，把结果广播给订阅者。
		 * @returns {object} 订阅接口。
		 */
		function createSource() {
			let snapshot = { loading: true, error: null, data: null };
			const listeners = new Set();
			let timer = null;
			let inflight = false;

			/** 发布新快照。 */
			function publish(next) {
				snapshot = next;
				for (const listener of listeners) listener();
			}

			/** 拉一次状态。 */
			async function refresh() {
				if (inflight) return;
				inflight = true;
				try {
					const response = await fetch(STATE_ROUTE, { headers: { accept: "application/json" }, credentials: "same-origin" });
					if (!response.ok) throw new Error("HTTP " + response.status);
					const data = await response.json();
					publish({ loading: false, error: null, data });
				} catch (error) {
					publish({ loading: false, error: String(error && error.message ? error.message : error), data: snapshot.data });
				} finally {
					inflight = false;
				}
			}

			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				start() {
					if (timer !== null) return;
					void refresh();
					timer = setInterval(() => void refresh(), POLL_MS);
				},
				stop() {
					if (timer === null) return;
					clearInterval(timer);
					timer = null;
				},
			};
		}

		/** 全局唯一的状态来源。 */
		const source = createSource();

		/**
		 * 订阅状态来源。
		 * @returns {object} 当前快照。
		 */
		function useSnapshot() {
			return react.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
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
		 * 全屏面板：阶段、流程图、下一步、成员。
		 * @returns {object} 页面元素。
		 */
		function ChartPage() {
			const snapshot = useSnapshot();
			const data = snapshot.data;
			const shell = { padding: "24px 28px", maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, fontFamily: "inherit" };

			if (data === null) {
				return h("div", { style: shell }, h("div", { style: { fontSize: 14, opacity: 0.75 } },
					snapshot.error === null ? "正在读取编排状态…" : "读不到状态：" + snapshot.error));
			}
			if (!data.enabled) {
				return h("div", { style: shell }, [
					h("div", { key: "title", style: { fontSize: 20, fontWeight: 600 } }, "编排"),
					h("div", { key: "hint", style: { fontSize: 14, opacity: 0.75 } }, "还没开启编排。在对话里敲 /orchestrate 开启。"),
				]);
			}

			const nodes = data.nodes ?? [];
			const edges = data.edges ?? [];
			const chartName = (data.charts ?? []).find((chart) => chart.id === data.selectedChart);
			const done = nodes.filter((node) => node.status === "完成").length;

			return h("div", { style: shell }, [
				h("div", { key: "head", style: { display: "flex", alignItems: "baseline", gap: 12 } }, [
					h("div", { key: "title", style: { fontSize: 20, fontWeight: 600 } }, "编排"),
					h("div", { key: "stage", style: { fontSize: 14, opacity: 0.8 } }, data.stage === "" ? "未写阶段" : data.stage),
					h("div", { key: "count", style: { marginLeft: "auto", fontSize: 13, opacity: 0.6 } },
						nodes.length === 0 ? "还没有选中图" : done + "/" + nodes.length + " 节点完成"),
				]),
				h("div", { key: "chart", style: { background: "var(--dsw-specific-sidebar-fill, rgba(255,255,255,0.03))", borderRadius: 14, padding: 16, border: "0.5px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12))" } },
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
		 * 侧边栏入口图标。
		 * @param {object} props {size, active}。
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

		/* ---------------- 注册 ---------------- */

		/**
		 * 插件入口：轮询状态，模式开着才挂入口。
		 * @param {object} ctx 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			injectStyle();
			ctx.effect(() => {
				let mainHandle = null;
				let entryHandle = null;

				/** 按当前 enabled 增删两个注册。 */
				function sync() {
					const snapshot = source.getSnapshot();
					const on = snapshot.data !== null && snapshot.data.enabled === true;
					if (on && mainHandle === null) {
						try {
							mainHandle = ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, ChartPage));
							entryHandle = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
								name: "sidebar.panellist",
								id: PANEL_ID,
								order: 20,
								label: () => "编排",
							}, OrchestrateGlyph));
						} catch (error) {
							mainHandle = null;
							entryHandle = null;
						}
					} else if (!on) {
						for (const handle of [mainHandle, entryHandle]) {
							if (typeof handle === "function") handle();
						}
						mainHandle = null;
						entryHandle = null;
					}
				}

				const unsubscribe = source.subscribe(sync);
				source.start();
				sync();
				return () => {
					unsubscribe();
					source.stop();
					for (const handle of [mainHandle, entryHandle]) {
						if (typeof handle === "function") handle();
					}
				};
			});
		}

		exports.ChartPage = ChartPage;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
