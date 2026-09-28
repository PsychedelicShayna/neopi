import type { ApiError, Issue } from "./wire";

export class SwitchError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: ApiError["error"]["detail"],
	) {
		super(message);
		this.name = "SwitchError";
	}

	toJSON(): ApiError {
		return { error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) } };
	}
}

export function invalid(issues: Issue[]): never {
	throw new SwitchError(422, "validation", "The request contains invalid fields", { issues });
}

export function unavailable(milestone: string, capability: string): never {
	throw new SwitchError(501, "capability_unavailable", `${capability} requires ${milestone}`, { requiredMilestone: milestone });
}

export function notFound(resource: string): never {
	throw new SwitchError(404, "not_found", `${resource} was not found`);
}
