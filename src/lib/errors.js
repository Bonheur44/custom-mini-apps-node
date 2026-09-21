/**
 * Thrown by a tool's service layer with a French, user-facing message. Routes turn it into a
 * 422 JSON `{ message }`; anything else bubbles up as a generic 500.
 */
export class ToolError extends Error {
    constructor(message, { cause, status = 422 } = {}) {
        super(message, { cause });
        this.name = 'ToolError';
        this.status = status;
    }
}

/**
 * Same shape as Laravel's form-request failure: `{ message, errors: { field: [messages] } }`,
 * which every screen's JS already knows how to render.
 */
export class ValidationError extends Error {
    constructor(errors) {
        super('Les données fournies sont invalides.');
        this.name = 'ValidationError';
        this.status = 422;
        this.errors = errors;
    }

    static single(field, message) {
        return new ValidationError({ [field]: [message] });
    }
}
