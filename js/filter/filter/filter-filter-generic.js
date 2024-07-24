import {FilterItem} from "../filter-item.js";
import {FilterBox} from "../filter-box.js";
import {FilterBase} from "./filter-filter-base.js";

class FilterTransientOptions {
	/**
	 * @param opts Options object.
	 * @param [opts.isExtendDefaultState]
	 */
	constructor (opts) {
		this.isExtendDefaultState = opts.isExtendDefaultState;
	}
}

export class Filter extends FilterBase {
	static _getAsFilterItems (items) {
		return items ? items.map(it => it instanceof FilterItem ? it : new FilterItem({item: it})) : null;
	}

	static _validateItemNests (items, nests) {
		if (!nests) return;
		items = items.filter(it => it.nest);
		const noNest = items.find(it => !nests[it.nest]);
		if (noNest) throw new Error(`Filter does not have matching nest: "${noNest.item}" (call addNest first)`);
		const invalid = items.find(it => !it.nest || !nests[it.nest]);
		if (invalid) throw new Error(`Invalid nest: "${invalid.item}"`);
	}

	/** A single-item version of the above, for performance. */
	static _validateItemNest (item, nests) {
		if (!nests || !item.nest) return;
		if (!nests[item.nest]) throw new Error(`Filter does not have matching nest: "${item.item}" (call addNest first)`);
		if (!item.nest || !nests[item.nest]) throw new Error(`Invalid nest: "${item.item}"`);
	}

	/**
	 * @param opts Options object.
	 * @param opts.header Filter header (name)
	 * @param [opts.headerHelp] Filter header help text (tooltip)
	 * @param opts.items Array of filter items, either `FilterItem` or strings. e.g. `["DMG", "VGM"]`
	 * @param [opts.nests] Key-value object of `"Nest Name": {...nestMeta}`. Nests are used to group/nest filters.
	 * @param [opts.displayFn] Function which translates an item to a displayable form, e.g. `"MM` -> "Monster Manual"`
	 * @param [opts.displayFnMini] Function which translates an item to a shortened displayable form, e.g. `"UABravoCharlie` -> "UABC"`
	 * @param [opts.displayFnTitle] Function which translates an item to a form for displaying in a "title" tooltip
	 * @param [opts.selFn] Function which returns true if an item should be displayed by default; false otherwise.
	 * @param [opts.deselFn] Function which returns true if an item should be hidden by default; false otherwise.
	 * @param [opts.itemSortFn] Function which should be used to sort the `items` array if new entries are added.
	 *        Defaults to ascending alphabetical sort.
	 * @param [opts.itemSortFnMini] Function which should be used to sort the `items` array when rendering mini-pills.
	 * @param [opts.groupFn] Function which takes an item and assigns it to a group.
	 * @param [opts.groupNameFn] Function which takes a group and returns a group name;
	 * @param [opts.minimalUi] True if the filter should render with a reduced UI, false otherwise.
	 * @param [opts.umbrellaItems] Items which should, when set active, show everything in the filter. E.g. "All".
	 * @param [opts.umbrellaExcludes] Items which should ignore the state of any `umbrellaItems`
	 * @param [opts.isSortByDisplayItems] If items should be sorted by their display value, rather than their internal value.
	 * @param [opts.isMiscFilter] If this is the Misc. filter (containing "SRD" and "Basic Rules" tags).
	 */
	constructor (opts) {
		super(opts);
		this._items = Filter._getAsFilterItems(opts.items || []);
		this.__itemsSet = new Set(this._items.map(it => it.item)); // Cache the items as a set for fast exists checking
		this._nests = opts.nests;
		this._displayFn = opts.displayFn;
		this._displayFnMini = opts.displayFnMini;
		this._displayFnTitle = opts.displayFnTitle;
		this._selFn = opts.selFn;
		this._selFnCache = null;
		this._deselFn = opts.deselFn;
		this._itemSortFn = opts.itemSortFn === undefined ? SortUtil.ascSort : opts.itemSortFn;
		this._itemSortFnMini = opts.itemSortFnMini;
		this._groupFn = opts.groupFn;
		this._groupNameFn = opts.groupNameFn;
		this._minimalUi = opts.minimalUi;
		this._umbrellaItems = Filter._getAsFilterItems(opts.umbrellaItems);
		this._umbrellaExcludes = Filter._getAsFilterItems(opts.umbrellaExcludes);
		this._isSortByDisplayItems = !!opts.isSortByDisplayItems;
		this._isReprintedFilter = !!opts.isMiscFilter && this._items.some(it => it.item === "Reprinted");
		this._isSrdFilter = !!opts.isMiscFilter && this._items.some(it => it.item === "SRD");
		this._isBasicRulesFilter = !!opts.isMiscFilter && this._items.some(it => it.item === "Basic Rules");

		Filter._validateItemNests(this._items, this._nests);

		this._filterBox = null;
		this._items.forEach(it => this._defaultItemState(it, {isForce: true}));
		this.__$wrpFilter = null;
		this.__wrpPills = null;
		this.__wrpMiniPills = null;
		this.__$wrpNestHeadInner = null;
		this._updateNestSummary = null;
		this.__nestsHidden = {};
		this._nestsHidden = this._getProxy("nestsHidden", this.__nestsHidden);
		this._isNestsDirty = false;
		this._isItemsDirty = false;
		this._pillGroupsMeta = {};
	}

	get isReprintedFilter () { return this._isReprintedFilter; }
	get isSrdFilter () { return this._isSrdFilter; }
	get isBasicRulesFilter () { return this._isBasicRulesFilter; }

	getSaveableState () {
		return {
			[this.header]: {
				...this.getBaseSaveableState(),
				state: {...this.__state},
				nestsHidden: {...this.__nestsHidden},
			},
		};
	}

	setStateFromLoaded (filterState, {isUserSavedState = false} = {}) {
		if (!filterState?.[this.header]) return;

		const toLoad = filterState[this.header];
		this._hasUserSavedState = this._hasUserSavedState || isUserSavedState;
		this.setBaseStateFromLoaded(toLoad);
		Object.assign(this._state, toLoad.state);
		Object.assign(this._nestsHidden, toLoad.nestsHidden);
	}

	_getStateNotDefault ({nxtState = null} = {}) {
		const state = nxtState?.[this.header]?.state || this.__state;

		return Object.entries(state)
			.filter(([k, v]) => {
				if (k.startsWith("_")) return false;
				const defState = this._getDefaultState(k);
				return defState !== v;
			});
	}

	getSubHashes () {
		const out = [];

		const baseMeta = this.getMetaSubHashes();
		if (baseMeta) out.push(...baseMeta);

		const areNotDefaultState = this._getStateNotDefault();
		if (areNotDefaultState.length) {
			// serialize state as `key=value` pairs
			const serPillStates = areNotDefaultState.map(([k, v]) => `${k.toUrlified()}=${v}`);
			out.push(UrlUtil.packSubHash(this.getSubHashPrefix("state", this.header), serPillStates));
		}

		const areNotDefaultNestsHidden = Object.entries(this._nestsHidden).filter(([k, v]) => this._nests[k] && !(this._nests[k].isHidden === v));
		if (areNotDefaultNestsHidden.length) {
			// serialize nestsHidden as `key=value` pairs
			const nestsHidden = areNotDefaultNestsHidden.map(([k]) => `${k.toUrlified()}=1`);
			out.push(UrlUtil.packSubHash(this.getSubHashPrefix("nestsHidden", this.header), nestsHidden));
		}

		if (!out.length) return null;

		// Always extend default state
		out.push(UrlUtil.packSubHash(this.getSubHashPrefix("options", this.header), ["extend"]));
		return out;
	}

	getFilterTagPart () {
		const areNotDefaultState = this._getStateNotDefault();
		const compressedMeta = this._getCompressedMeta({isStripUiKeys: true});

		// If _any_ value is non-default, we need to include _all_ values in the tag
		// The same goes for meta values
		if (!areNotDefaultState.length && !compressedMeta) return null;

		const pt = Object.entries(this._state)
			.filter(([k]) => !k.startsWith("_"))
			.filter(([, v]) => v)
			.map(([k, v]) => `${v === 2 ? "!" : ""}${k}`)
			.join(";")
			.toLowerCase();

		return [
			this.header.toLowerCase(),
			pt,
			compressedMeta ? compressedMeta.join(HASH_SUB_LIST_SEP) : null,
		]
			.filter(it => it != null)
			.join("=");
	}

	getDisplayStatePart ({nxtState = null} = {}) {
		const state = nxtState?.[this.header]?.state || this.__state;

		const areNotDefaultState = this._getStateNotDefault({nxtState});

		// If _any_ value is non-default, we need to include _all_ values in the tag
		if (!areNotDefaultState.length) return null;

		const ptState = Object.entries(state)
			.filter(([k]) => !k.startsWith("_"))
			.filter(([, v]) => v)
			.map(([k, v]) => {
				const item = this._items.find(item => `${item.item}` === k);
				if (!item) return null; // Should never occur
				return `${v === 2 ? "not " : ""}${this._displayFn ? this._displayFn(item.item, item) : item.item}`;
			})
			.filter(Boolean)
			.join(", ");

		if (!ptState) return null;

		return `${this.header}: ${ptState}`;
	}

	/**
	 * Get transient options used when setting state from URL.
	 * @private
	 */
	_getOptionsFromSubHashState (state) {
		// `flopsource:thing1~thing2` => `{options: ["thing1", "thing2"]}`
		const opts = {};
		Object.entries(state).forEach(([k, vals]) => {
			const prop = FilterBase.getProp(k);
			switch (prop) {
				case "options": {
					vals.forEach(val => {
						switch (val) {
							case "extend": {
								opts.isExtendDefaultState = true;
							}
						}
					});
				}
			}
		});
		return new FilterTransientOptions(opts);
	}

	setStateFromNextState (nxtState) {
		super.setStateFromNextState(nxtState);
		this._proxyAssignSimple("nestsHidden", nxtState[this.header].nestsHidden, true);
	}

	getNextStateFromSubhashState (state) {
		const nxtState = this._getNextState_base();

		if (state == null) {
			this._mutNextState_reset(nxtState);
			return nxtState;
		}

		this._mutNextState_meta_fromSubHashState(nxtState, state);
		const transientOptions = this._getOptionsFromSubHashState(state);

		let hasState = false;
		let hasNestsHidden = false;

		Object.entries(state).forEach(([k, vals]) => {
			const prop = FilterBase.getProp(k);
			switch (prop) {
				case "state": {
					hasState = true;
					if (transientOptions.isExtendDefaultState) {
						Object.keys(nxtState[this.header].state).forEach(k => nxtState[this.header].state[k] = this._getDefaultState(k));
					} else {
						// This allows e.g. @filter tags to cleanly specify their sources
						Object.keys(nxtState[this.header].state).forEach(k => nxtState[this.header].state[k] = 0);
					}

					vals.forEach(v => {
						const [statePropLower, state] = v.split("=");
						const stateProp = Object.keys(nxtState[this.header].state).find(k => k.toLowerCase() === statePropLower);
						if (stateProp) nxtState[this.header].state[stateProp] = Number(state);
					});
					break;
				}
				case "nestsHidden": {
					hasNestsHidden = true;
					Object.keys(nxtState[this.header].nestsHidden).forEach(k => {
						const nestKey = Object.keys(this._nests).find(it => k.toLowerCase() === it.toLowerCase());
						nxtState[this.header].nestsHidden[k] = this._nests[nestKey] && this._nests[nestKey].isHidden;
					});
					vals.forEach(v => {
						const [nestNameLower, state] = v.split("=");
						const nestName = Object.keys(nxtState[this.header].nestsHidden).find(k => k.toLowerCase() === nestNameLower);
						if (nestName) nxtState[this.header].nestsHidden[nestName] = !!Number(state);
					});
					break;
				}
			}
		});

		if (!hasState) this._mutNextState_reset(nxtState);
		if (!hasNestsHidden && this._nests) this._mutNextState_resetNestsHidden({tgt: nxtState[this.header].nestsHidden});

		return nxtState;
	}

	setFromValues (values) {
		if (values[this.header]) {
			Object.keys(this._state).forEach(k => this._state[k] = 0);
			Object.assign(this._state, values[this.header]);
		}
	}

	setValue (k, v) { this._state[k] = v; }

	_mutNextState_resetNestsHidden ({tgt}) {
		if (!this._nests) return;
		Object.entries(this._nests).forEach(([nestName, nestMeta]) => tgt[nestName] = !!nestMeta.isHidden);
	}

	_defaultItemState (item, {isForce = false} = {}) {
		// Avoid setting state for new items if the user already has active filter state. This prevents the case where e.g.:
		//   - The user has cleared their source filter;
		//   - A new source is added to the site;
		//   - The new source becomes the *only* selected item in their filter.
		if (!isForce && this._hasUserSavedState && !Object.values(this.__state).some(Boolean)) return this._state[item.item] = 0;

		// if both a selFn and a deselFn are specified, we default to deselecting
		this._state[item.item] = this._getDefaultState(item.item);
	}

	_getDefaultState (k) { return this._deselFn && this._deselFn(k) ? 2 : this._selFn && this._selFn(k) ? 1 : 0; }

	_getDisplayText (item) {
		return this._displayFn ? this._displayFn(item.item, item) : item.item;
	}

	_getDisplayTextMini (item) {
		return this._displayFnMini
			? this._displayFnMini(item.item, item)
			: this._getDisplayText(item);
	}

	_getPill (item) {
		const displayText = this._getDisplayText(item);

		const btnPill = e_({
			tag: "div",
			clazz: "fltr__pill",
			html: displayText,
			click: evt => this._getPill_handleClick({evt, item}),
			contextmenu: evt => this._getPill_handleContextmenu({evt, item}),
		});

		this._getPill_bindHookState({btnPill, item});

		item.searchText = displayText.toLowerCase();

		return btnPill;
	}

	_getPill_handleClick ({evt, item}) {
		if (evt.shiftKey) {
			this._doSetPillsClear();
		}

		if (++this._state[item.item] > 2) this._state[item.item] = 0;
	}

	_getPill_handleContextmenu ({evt, item}) {
		evt.preventDefault();

		if (evt.shiftKey) {
			this._doSetPillsClear();
		}

		if (--this._state[item.item] < 0) this._state[item.item] = 2;
	}

	_getPill_bindHookState ({btnPill, item}) {
		this._addHook("state", item.item, () => {
			const val = FilterBox._PILL_STATES[this._state[item.item]];
			btnPill.attr("state", val);
		})();
	}

	setTempFnSel (tempFnSel) {
		this._selFnCache = this._selFnCache || this._selFn;
		if (tempFnSel) this._selFn = tempFnSel;
		else this._selFn = this._selFnCache;
	}

	updateMiniPillClasses () {
		this._items.filter(it => it.btnMini).forEach(it => {
			const isDefaultDesel = this._deselFn && this._deselFn(it.item);
			const isDefaultSel = this._selFn && this._selFn(it.item);
			it.btnMini
				.toggleClass("fltr__mini-pill--default-desel", isDefaultDesel)
				.toggleClass("fltr__mini-pill--default-sel", isDefaultSel);
		});
	}

	_getBtnMini (item) {
		const toDisplay = this._getDisplayTextMini(item);

		const btnMini = e_({
			tag: "div",
			clazz: `fltr__mini-pill ${this._filterBox.isMinisHidden(this.header) ? "ve-hidden" : ""} ${this._deselFn && this._deselFn(item.item) ? "fltr__mini-pill--default-desel" : ""} ${this._selFn && this._selFn(item.item) ? "fltr__mini-pill--default-sel" : ""}`,
			html: toDisplay,
			title: `${this._displayFnTitle ? `${this._displayFnTitle(item.item, item)} (` : ""}Filter: ${this.header}${this._displayFnTitle ? ")" : ""}`,
			click: () => {
				this._state[item.item] = 0;
				this._filterBox.fireChangeEvent();
			},
		}).attr("state", FilterBox._PILL_STATES[this._state[item.item]]);

		const hook = () => {
			const val = FilterBox._PILL_STATES[this._state[item.item]];
			btnMini.attr("state", val);
			// Bind change handlers in the mini-pill render step, as the mini-pills should always be available.
			if (item.pFnChange) item.pFnChange(item.item, val);
		};
		this._addHook("state", item.item, hook);

		const hideHook = () => btnMini.toggleClass("ve-hidden", this._filterBox.isMinisHidden(this.header));
		this._filterBox.registerMinisHiddenHook(this.header, hideHook);

		return btnMini;
	}

	_doSetPillsAll () {
		this._proxyAssignSimple(
			"state",
			Object.keys(this._state)
				.mergeMap(k => ({[k]: 1})),
			true,
		);
	}

	_doSetPillsClear () {
		this._proxyAssignSimple(
			"state",
			Object.keys(this._state)
				.mergeMap(k => ({[k]: 0})),
			true,
		);
	}

	_doSetPillsNone () {
		this._proxyAssignSimple(
			"state",
			Object.keys(this._state)
				.mergeMap(k => ({[k]: 2})),
			true,
		);
	}

	_doSetPinsDefault () {
		this.reset();
	}

	_getHeaderControls (opts) {
		const btnAll = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} fltr__h-btn--all w-100`,
			click: () => this._doSetPillsAll(),
			html: "All",
		});
		const btnClear = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} fltr__h-btn--clear w-100`,
			click: () => this._doSetPillsClear(),
			html: "Clear",
		});
		const btnNone = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} fltr__h-btn--none w-100`,
			click: () => this._doSetPillsNone(),
			html: "None",
		});
		const btnDefault = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} w-100`,
			click: () => this._doSetPinsDefault(),
			html: "Default",
		});

		const wrpStateBtnsOuter = e_({
			tag: "div",
			clazz: "ve-flex-v-center fltr__h-wrp-state-btns-outer",
			children: [
				e_({
					tag: "div",
					clazz: "btn-group ve-flex-v-center w-100",
					children: [
						btnAll,
						btnClear,
						btnNone,
						btnDefault,
					],
				}),
			],
		});
		this._getHeaderControls_addExtraStateBtns(opts, wrpStateBtnsOuter);

		const wrpSummary = e_({tag: "div", clazz: "ve-flex-vh-center ve-hidden"});

		const btnCombineBlue = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} fltr__h-btn-logic--blue fltr__h-btn-logic w-100`,
			click: () => this._meta.combineBlue = Filter._getNextCombineMode(this._meta.combineBlue),
			title: `Blue match mode for this filter. "AND" requires all blues to match, "OR" requires at least one blue to match, "XOR" requires exactly one blue to match.`,
		});
		const hookCombineBlue = () => e_({ele: btnCombineBlue, text: `${this._meta.combineBlue}`.toUpperCase()});
		this._addHook("meta", "combineBlue", hookCombineBlue);
		hookCombineBlue();

		const btnCombineRed = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} fltr__h-btn-logic--red fltr__h-btn-logic w-100`,
			click: () => this._meta.combineRed = Filter._getNextCombineMode(this._meta.combineRed),
			title: `Red match mode for this filter. "AND" requires all reds to match, "OR" requires at least one red to match, "XOR" requires exactly one red to match.`,
		});
		const hookCombineRed = () => e_({ele: btnCombineRed, text: `${this._meta.combineRed}`.toUpperCase()});
		this._addHook("meta", "combineRed", hookCombineRed);
		hookCombineRed();

		const btnShowHide = e_({
			tag: "button",
			clazz: `btn btn-default ${opts.isMulti ? "btn-xxs" : "btn-xs"} ml-2`,
			click: () => this._meta.isHidden = !this._meta.isHidden,
			html: "Hide",
		});
		const hookShowHide = () => {
			e_({ele: btnShowHide}).toggleClass("active", this._meta.isHidden);
			wrpStateBtnsOuter.toggleVe(!this._meta.isHidden);

			// render summary
			const cur = this.getValues()[this.header];

			const htmlSummary = [
				cur._totals.yes
					? `<span class="fltr__summary_item fltr__summary_item--include" title="${cur._totals.yes} hidden &quot;required&quot; tags">${cur._totals.yes}</span>`
					: null,
				cur._totals.yes && cur._totals.no
					? `<span class="fltr__summary_item_spacer"></span>`
					: null,
				cur._totals.no
					? `<span class="fltr__summary_item fltr__summary_item--exclude" title="${cur._totals.no} hidden &quot;excluded&quot; tags">${cur._totals.no}</span>`
					: null,
			].filter(Boolean).join("");
			e_({ele: wrpSummary, html: htmlSummary}).toggleVe(this._meta.isHidden);
		};
		this._addHook("meta", "isHidden", hookShowHide);
		hookShowHide();

		return e_({
			tag: "div",
			clazz: `ve-flex-v-center fltr__h-wrp-btns-outer`,
			children: [
				wrpSummary,
				wrpStateBtnsOuter,
				e_({tag: "span", clazz: `btn-group ml-2 ve-flex-v-center`, children: [btnCombineBlue, btnCombineRed]}),
				btnShowHide,
			],
		});
	}

	_getHeaderControls_addExtraStateBtns () {
		// To be optionally implemented by child classes
	}

	/**
	 * @param opts Options.
	 * @param opts.filterBox The FilterBox to which this filter is attached.
	 * @param opts.isFirst True if this is visually the first filter in the box.
	 * @param opts.$wrpMini The form mini-view element.
	 * @param opts.isMulti The name of the MultiFilter this filter belongs to, if any.
	 */
	$render (opts) {
		this._filterBox = opts.filterBox;
		this.__wrpMiniPills = opts.$wrpMini ? e_({ele: opts.$wrpMini[0]}) : null;

		const wrpControls = this._getHeaderControls(opts);

		if (this._nests) {
			const wrpNestHead = e_({tag: "div", clazz: "fltr__wrp-pills--sub"}).appendTo(this.__wrpPills);
			this.__$wrpNestHeadInner = e_({tag: "div", clazz: "ve-flex ve-flex-wrap fltr__container-pills"}).appendTo(wrpNestHead);

			const wrpNestHeadSummary = e_({tag: "div", clazz: "fltr__summary_nest"}).appendTo(wrpNestHead);

			this._updateNestSummary = () => {
				const stats = {high: 0, low: 0};
				this._items.filter(it => this._state[it.item] && this._nestsHidden[it.nest]).forEach(it => {
					const key = this._state[it.item] === 1 ? "high" : "low";
					stats[key]++;
				});

				wrpNestHeadSummary.empty();

				if (stats.high) {
					e_({
						tag: "span",
						clazz: "fltr__summary_item fltr__summary_item--include",
						text: stats.high,
						title: `${stats.high} hidden "required" tag${stats.high === 1 ? "" : "s"}`,
					}).appendTo(wrpNestHeadSummary);
				}

				if (stats.high && stats.low) e_({tag: "span", clazz: "fltr__summary_item_spacer"}).appendTo(wrpNestHeadSummary);

				if (stats.low) {
					e_({
						tag: "span",
						clazz: "fltr__summary_item fltr__summary_item--exclude",
						text: stats.low,
						title: `${stats.low} hidden "excluded" tag${stats.low === 1 ? "" : "s"}`,
					}).appendTo(wrpNestHeadSummary);
				}
			};

			this._doRenderNests();
		}

		this._doRenderPills();

		const btnMobToggleControls = this._getBtnMobToggleControls(wrpControls);

		this.__$wrpFilter = $$`<div>
			${opts.isFirst ? "" : `<div class="fltr__dropdown-divider ${opts.isMulti ? "fltr__dropdown-divider--indented" : ""} mb-1"></div>`}
			<div class="split fltr__h ${this._minimalUi ? "fltr__minimal-hide" : ""} mb-1">
				<div class="fltr__h-text ve-flex-h-center mobile__w-100">
					${opts.isMulti ? `<span class="mr-2">\u2012</span>` : ""}
					${this._getRenderedHeader()}
					${btnMobToggleControls}
				</div>
				${wrpControls}
			</div>
			${this.__wrpPills}
		</div>`;

		this._doToggleDisplay();

		return this.__$wrpFilter;
	}

	/**
	 * @param opts Options.
	 * @param opts.filterBox The FilterBox to which this filter is attached.
	 * @param opts.isFirst True if this is visually the first filter in the box.
	 * @param opts.$wrpMini The form mini-view element.
	 * @param opts.isMulti The name of the MultiFilter this filter belongs to, if any.
	 */
	$renderMinis (opts) {
		if (!opts.$wrpMini) return;

		this._filterBox = opts.filterBox;
		this.__wrpMiniPills = e_({ele: opts.$wrpMini[0]});

		this._renderMinis_initWrpPills();

		this._doRenderMiniPills();
	}

	_renderMinis_initWrpPills () {
		this.__wrpPills = e_({tag: "div", clazz: `fltr__wrp-pills ${this._groupFn ? "fltr__wrp-subs" : "fltr__container-pills"}`});
		const hook = () => this.__wrpPills.toggleVe(!this._meta.isHidden);
		this._addHook("meta", "isHidden", hook);
		hook();
	}

	getValues ({nxtState = null} = {}) {
		const state = MiscUtil.copy(nxtState?.[this.header]?.state || this.__state);
		const meta = nxtState?.[this.header]?.meta || this.__meta;

		// remove state for any currently-absent filters
		Object.keys(state).filter(k => !this._items.some(it => `${it.item}` === k)).forEach(k => delete state[k]);
		const out = {...state};

		// add helper data
		out._isActive = Object.values(state).some(Boolean);
		out._totals = {yes: 0, no: 0, ignored: 0};
		Object.values(state).forEach(v => {
			const totalKey = v === 0 ? "ignored" : v === 1 ? "yes" : "no";
			out._totals[totalKey]++;
		});
		out._combineBlue = meta.combineBlue;
		out._combineRed = meta.combineRed;
		return {[this.header]: out};
	}

	_getNextState_base () {
		return {
			[this.header]: {
				...super._getNextState_base()[this.header],
				nestsHidden: MiscUtil.copyFast(this.__nestsHidden),
			},
		};
	}

	_mutNextState_reset (nxtState, {isResetAll = false} = {}) {
		if (isResetAll) {
			this._mutNextState_resetBase(nxtState);
			this._mutNextState_resetNestsHidden({tgt: nxtState[this.header].nestsHidden});
		} else {
			// Always reset "AND/OR" states
			Object.assign(nxtState[this.header].meta, {combineBlue: Filter._DEFAULT_META.combineBlue, combineRed: Filter._DEFAULT_META.combineRed});
		}
		Object.keys(nxtState[this.header].state).forEach(k => delete nxtState[this.header].state[k]);
		this._items.forEach(item => nxtState[this.header].state[item.item] = this._getDefaultState(item.item));
	}

	_doRenderPills () {
		if (this._itemSortFn) this._items.sort(this._isSortByDisplayItems && this._displayFn ? (a, b) => this._itemSortFn(this._displayFn(a.item, a), this._displayFn(b.item, b)) : this._itemSortFn);

		this._items.forEach(it => {
			if (!it.rendered) {
				it.rendered = this._getPill(it);
				if (it.nest) {
					const hook = () => it.rendered.toggleVe(!this._nestsHidden[it.nest]);
					this._addHook("nestsHidden", it.nest, hook);
					hook();
				}
			}

			if (this._groupFn) {
				const group = this._groupFn(it);
				this._doRenderPills_doRenderWrpGroup(group);
				this._pillGroupsMeta[group].wrpPills.append(it.rendered);
			} else it.rendered.appendTo(this.__wrpPills);
		});
	}

	_doRenderPills_doRenderWrpGroup (group) {
		const existingMeta = this._pillGroupsMeta[group];
		if (existingMeta && !existingMeta.isAttached) {
			existingMeta.wrpDivider.appendTo(this.__wrpPills);
			existingMeta.wrpPills.appendTo(this.__wrpPills);
			existingMeta.isAttached = true;
		}
		if (existingMeta) return;

		this._pillGroupsMeta[group] = {
			wrpDivider: this._doRenderPills_doRenderWrpGroup_getDivider(group).appendTo(this.__wrpPills),
			wrpPills: this._doRenderPills_doRenderWrpGroup_getWrpPillsSub(group).appendTo(this.__wrpPills),
			isAttached: true,
		};

		Object.entries(this._pillGroupsMeta)
			.sort((a, b) => SortUtil.ascSortLower(a[0], b[0]))
			.forEach(([groupKey, groupMeta], i) => {
				groupMeta.wrpDivider.appendTo(this.__wrpPills);
				groupMeta.wrpDivider.toggleVe(!this._isGroupDividerHidden(groupKey, i));
				groupMeta.wrpPills.appendTo(this.__wrpPills);
			});

		if (this._nests) {
			this._pillGroupsMeta[group].toggleDividerFromNestVisibility = () => {
				this._pillGroupsMeta[group].wrpDivider.toggleVe(!this._isGroupDividerHidden(group));
			};

			// bind group dividers to show/hide depending on nest visibility state
			Object.keys(this._nests).forEach(nestName => {
				const hook = () => this._pillGroupsMeta[group].toggleDividerFromNestVisibility();
				this._addHook("nestsHidden", nestName, hook);
				hook();
				this._pillGroupsMeta[group].toggleDividerFromNestVisibility();
			});
		}
	}

	_isGroupDividerHidden (group, ixSortedGroups) {
		if (!this._nests) {
			// When not nested, always hide the first divider
			if (ixSortedGroups === undefined) return `${group}` === `${Object.keys(this._pillGroupsMeta).sort((a, b) => SortUtil.ascSortLower(a, b))[0]}`;
			return ixSortedGroups === 0;
		}

		const groupItems = this._items.filter(it => this._groupFn(it) === group);
		const hiddenGroupItems = groupItems.filter(it => this._nestsHidden[it.nest]);
		return groupItems.length === hiddenGroupItems.length;
	}

	_doRenderPills_doRenderWrpGroup_getDivider (group) {
		const eleHr = this._doRenderPills_doRenderWrpGroup_getDividerHr(group);
		const elesHeader = this._doRenderPills_doRenderWrpGroup_getDividerHeaders(group);

		return e_({
			tag: "div",
			clazz: "ve-flex-col w-100",
			children: [
				eleHr,
				...elesHeader,
			]
				.filter(Boolean),
		});
	}

	_doRenderPills_doRenderWrpGroup_getDividerHr (group) { return e_({tag: "hr", clazz: `fltr__dropdown-divider--sub hr-2 mx-3`}); }

	_doRenderPills_doRenderWrpGroup_getDividerHeaders (group) {
		const groupName = this._groupNameFn?.(group);
		if (!groupName) return [];

		return [
			e_({
				tag: "div",
				clazz: `fltr__divider-header ve-muted italic ve-small`,
				text: groupName,
			}),
		];
	}

	_doRenderPills_doRenderWrpGroup_getWrpPillsSub () { return e_({tag: "div", clazz: `fltr__wrp-pills--sub fltr__container-pills`}); }

	_doRenderMiniPills () {
		// create a list view so we can freely sort
		const view = this._items.slice(0);
		if (this._itemSortFnMini || this._itemSortFn) {
			const fnSort = this._itemSortFnMini || this._itemSortFn;
			view.sort(this._isSortByDisplayItems && this._displayFn ? (a, b) => fnSort(this._displayFn(a.item, a), this._displayFn(b.item, b)) : fnSort);
		}

		if (this.__wrpMiniPills) {
			view.forEach(it => {
				// re-append existing elements to sort them
				(it.btnMini = it.btnMini || this._getBtnMini(it)).appendTo(this.__wrpMiniPills);
			});
		}
	}

	_doToggleDisplay () {
		// if there are no items, hide everything
		if (this.__$wrpFilter) this.__$wrpFilter.toggleClass("fltr__no-items", !this._items.length);
	}

	_doRenderNests () {
		Object.entries(this._nests)
			.sort((a, b) => SortUtil.ascSort(a[0], b[0])) // array 0 (key) is the nest name
			.forEach(([nestName, nestMeta]) => {
				if (nestMeta._$btnNest == null) {
					// this can be restored from a saved state, otherwise, initialise it
					if (this._nestsHidden[nestName] == null) this._nestsHidden[nestName] = !!nestMeta.isHidden;

					const $btnText = $(`<span>${nestName} [${this._nestsHidden[nestName] ? "+" : "\u2212"}]</span>`);
					nestMeta._$btnNest = $$`<div class="fltr__btn_nest">${$btnText}</div>`
						.click(() => this._nestsHidden[nestName] = !this._nestsHidden[nestName]);

					const hook = () => {
						$btnText.text(`${nestName} [${this._nestsHidden[nestName] ? "+" : "\u2212"}]`);

						const stats = {high: 0, low: 0, total: 0};
						this._items
							.filter(it => it.nest === nestName)
							.find(it => {
								const key = this._state[it.item] === 1 ? "high" : this._state[it.item] ? "low" : "ignored";
								stats[key]++;
								stats.total++;
							});
						const allHigh = stats.total === stats.high;
						const allLow = stats.total === stats.low;
						nestMeta._$btnNest.toggleClass("fltr__btn_nest--include-all", this._nestsHidden[nestName] && allHigh)
							.toggleClass("fltr__btn_nest--exclude-all", this._nestsHidden[nestName] && allLow)
							.toggleClass("fltr__btn_nest--include", this._nestsHidden[nestName] && !!(!allHigh && !allLow && stats.high && !stats.low))
							.toggleClass("fltr__btn_nest--exclude", this._nestsHidden[nestName] && !!(!allHigh && !allLow && !stats.high && stats.low))
							.toggleClass("fltr__btn_nest--both", this._nestsHidden[nestName] && !!(!allHigh && !allLow && stats.high && stats.low));

						if (this._updateNestSummary) this._updateNestSummary();
					};

					this._items
						.filter(it => it.nest === nestName)
						.find(it => {
							this._addHook("state", it.item, hook);
						});

					this._addHook("nestsHidden", nestName, hook);
					hook();
				}
				nestMeta._$btnNest.appendTo(this.__$wrpNestHeadInner);
			});

		if (this._updateNestSummary) this._updateNestSummary();
	}

	update () {
		if (this._isNestsDirty) {
			this._isNestsDirty = false;

			this._doRenderNests();
		}

		if (this._isItemsDirty) {
			this._isItemsDirty = false;

			this._doRenderPills();
		}

		// always render the mini-pills, to ensure the overall order in the grid stays correct (shared between multiple filters)
		this._doRenderMiniPills();
		this._doToggleDisplay();
	}

	_getFilterItem (item) {
		return item instanceof FilterItem ? item : new FilterItem({item});
	}

	addItem (item) {
		if (item == null) return;

		if (item instanceof Array) {
			const len = item.length;
			for (let i = 0; i < len; ++i) this.addItem(item[i]);
			return;
		}

		if (!this.__itemsSet.has(item.item || item)) {
			item = this._getFilterItem(item);
			Filter._validateItemNest(item, this._nests);

			this._isItemsDirty = true;
			this._items.push(item);
			this.__itemsSet.add(item.item);
			if (this._state[item.item] == null) this._defaultItemState(item);
		}
	}

	addNest (nestName, nestMeta) {
		// may need to allow this in future
		// can easily be circumvented by initialising with empty nests in filter construction
		if (!this._nests) throw new Error(`Filter was not nested!`);
		if (!this._nests[nestName]) {
			this._isNestsDirty = true;
			this._nests[nestName] = nestMeta;

			// bind group dividers to show/hide based on the new nest
			if (this._groupFn) {
				Object.keys(this._pillGroupsMeta).forEach(group => {
					const hook = () => this._pillGroupsMeta[group].toggleDividerFromNestVisibility();
					this._addHook("nestsHidden", nestName, hook);
					hook();
					this._pillGroupsMeta[group].toggleDividerFromNestVisibility();
				});
			}
		}
	}

	_toDisplay_getMappedEntryVal (entryVal) {
		if (!(entryVal instanceof Array)) entryVal = [entryVal];
		entryVal = entryVal.map(it => it instanceof FilterItem ? it : new FilterItem({item: it}));
		return entryVal;
	}

	_toDisplay_getFilterState (boxState) { return boxState[this.header]; }

	toDisplay (boxState, entryVal) {
		const filterState = this._toDisplay_getFilterState(boxState);
		if (!filterState) return true;

		const totals = filterState._totals;

		entryVal = this._toDisplay_getMappedEntryVal(entryVal);

		const isUmbrella = () => {
			if (this._umbrellaItems) {
				if (!entryVal) return false;

				if (this._umbrellaExcludes && this._umbrellaExcludes.some(it => filterState[it.item])) return false;

				return this._umbrellaItems.some(u => entryVal.includes(u.item))
					&& (this._umbrellaItems.some(u => filterState[u.item] === 0) || this._umbrellaItems.some(u => filterState[u.item] === 1));
			}
		};

		let hide = false;
		let display = false;

		switch (filterState._combineBlue) {
			case "or": {
				// default to displaying
				if (totals.yes === 0) display = true;

				// if any are 1 (blue) include if they match
				display = display || entryVal.some(fi => filterState[fi.item] === 1 || isUmbrella());

				break;
			}
			case "xor": {
				// default to displaying
				if (totals.yes === 0) display = true;

				// if any are 1 (blue) include if precisely one matches
				display = display || entryVal.filter(fi => filterState[fi.item] === 1 || isUmbrella()).length === 1;

				break;
			}
			case "and": {
				const totalYes = entryVal.filter(fi => filterState[fi.item] === 1).length;
				display = !totals.yes || totals.yes === totalYes;

				break;
			}
			default: throw new Error(`Unhandled combine mode "${filterState._combineBlue}"`);
		}

		switch (filterState._combineRed) {
			case "or": {
				// if any are 2 (red) exclude if they match
				hide = hide || entryVal.filter(fi => !fi.isIgnoreRed).some(fi => filterState[fi.item] === 2);

				break;
			}
			case "xor": {
				// if exactly one is 2 (red) exclude if it matches
				hide = hide || entryVal.filter(fi => !fi.isIgnoreRed).filter(fi => filterState[fi.item] === 2).length === 1;

				break;
			}
			case "and": {
				const totalNo = entryVal.filter(fi => !fi.isIgnoreRed).filter(fi => filterState[fi.item] === 2).length;
				hide = totals.no && totals.no === totalNo;

				break;
			}
			default: throw new Error(`Unhandled combine mode "${filterState._combineRed}"`);
		}

		return display && !hide;
	}

	_doInvertPins () {
		const cur = MiscUtil.copy(this._state);
		Object.keys(this._state).forEach(k => this._state[k] = cur[k] === 1 ? 0 : 1);
	}

	getDefaultMeta () {
		// Key order is important, as @filter tags depend on it
		return {
			...super.getDefaultMeta(),
			...Filter._DEFAULT_META,
		};
	}

	handleSearch (searchTerm) {
		const isHeaderMatch = this.header.toLowerCase().includes(searchTerm);

		if (isHeaderMatch) {
			this._items.forEach(it => {
				if (!it.rendered) return;
				it.rendered.toggleClass("fltr__hidden--search", false);
			});

			if (this.__$wrpFilter) this.__$wrpFilter.toggleClass("fltr__hidden--search", false);

			return true;
		}

		let visibleCount = 0;
		this._items.forEach(it => {
			if (!it.rendered) return;
			const isVisible = it.searchText.includes(searchTerm);
			it.rendered.toggleClass("fltr__hidden--search", !isVisible);
			if (isVisible) visibleCount++;
		});

		if (this.__$wrpFilter) this.__$wrpFilter.toggleClass("fltr__hidden--search", visibleCount === 0);

		return visibleCount !== 0;
	}

	static _getNextCombineMode (combineMode) {
		let ix = Filter._COMBINE_MODES.indexOf(combineMode);
		if (ix === -1) ix = (Filter._COMBINE_MODES.length - 1);
		if (++ix === Filter._COMBINE_MODES.length) ix = 0;
		return Filter._COMBINE_MODES[ix];
	}

	_doTeardown () {
		this._items.forEach(it => {
			if (it.rendered) it.rendered.detach();
			if (it.btnMini) it.btnMini.detach();
		});

		Object.values(this._nests || {})
			.filter(nestMeta => nestMeta._$btnNest)
			.forEach(nestMeta => nestMeta._$btnNest.detach());

		Object.values(this._pillGroupsMeta || {})
			.forEach(it => {
				it.wrpDivider.detach();
				it.wrpPills.detach();
				it.isAttached = false;
			});
	}
}
Filter._DEFAULT_META = {
	combineBlue: "or",
	combineRed: "or",
};
Filter._COMBINE_MODES = ["or", "and", "xor"];
