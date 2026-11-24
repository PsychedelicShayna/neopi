import { getLocale, t } from "@oh-my-pi/pi-utils/i18n";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/** Stored account identity rendered and matched by the session account picker. */
export interface SessionPinAccount {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	label: string;
}

/** What tells two accounts of one provider apart besides their label: the organization, project or host. */
function accountDetail(account: SessionPinAccount): string | undefined {
	const parts = [account.orgName ?? account.orgId, account.projectId, account.enterpriseUrl].filter(
		(part): part is string => typeof part === "string" && part.trim().length > 0 && !account.label.includes(part),
	);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function sessionAccountItems(accounts: readonly SessionPinAccount[]): SelectItem[] {
	return accounts.map(account => ({
		value: String(account.credentialId),
		label: account.label,
		description: account.active ? t("overlaysModel.sessionAccount.active") : undefined,
	}));
}

/** Account picker opened by `/session pin` for the current model provider. */
export class SessionAccountSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;
	readonly #providerName: string;
	readonly #accounts: readonly SessionPinAccount[];
	#locale = getLocale();

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		onSelect: (account: SessionPinAccount) => void,
		onCancel: () => void,
	) {
		super(
			t("overlaysModel.sessionAccount.title.terminal", { provider: providerName }),
			"omp.overlay.session-account",
		);
		this.#providerName = providerName;
		this.#accounts = accounts;
		const accountsByValue = new Map(accounts.map(account => [String(account.credentialId), account] as const));
		const items = sessionAccountItems(accounts);

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE),
			getSelectListTheme(),
			{ search: "always" },
		);
		const activeIndex = accounts.findIndex(account => account.active);
		if (activeIndex >= 0) this.#selectList.setSelectedIndex(activeIndex);
		this.#selectList.onSelect = item => {
			const account = accountsByValue.get(item.value);
			if (account) onSelect(account);
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		// Natively the active account carries the picker's current check, so the
		// row's detail is what tells accounts apart instead of "active for this session".
		this.#sheet = new SelectListSheet(this.#selectList, () => ({
			title: t("overlaysModel.sessionAccount.title.picker", { provider: providerName }),
			subtitle: t("overlaysModel.sessionAccount.subtitle"),
			icon: "key-round",
			noun: t("overlaysModel.sessionAccount.noun"),
			current: accounts.filter(account => account.active).map(account => String(account.credentialId)),
			confirm: t("overlaysModel.sessionAccount.action.pin"),
			decorate: item => {
				const account = accountsByValue.get(item.value);
				if (!account) return undefined;
				const detail = accountDetail(account);
				return { mark: { text: account.email ?? account.label, seed: account.label }, detail: detail ?? "" };
			},
		}));
	}

	#syncLocale(): void {
		const locale = getLocale();
		if (this.#locale === locale) return;
		this.#locale = locale;
		this.title = t("overlaysModel.sessionAccount.title.terminal", { provider: this.#providerName });
		this.#selectList.setItems(sessionAccountItems(this.#accounts));
	}

	override render(width: number): readonly string[] {
		this.#syncLocale();
		return super.render(width);
	}

	override describe(cx: DescribeContext): NativeNode | null {
		this.#syncLocale();
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	navigationSnapshot(): unknown {
		return this.#selectList.navigationState();
	}

	restoreNavigation(snapshot: unknown): void {
		this.#selectList.restoreNavigation(snapshot);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
