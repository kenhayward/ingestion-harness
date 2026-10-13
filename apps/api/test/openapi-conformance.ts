import Ajv, { type ValidateFunction } from 'ajv';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3_1 } from 'openapi-types';

/**
 * Response conformance (docs/design/api-docs.md): every response a documented route sends in the
 * test suite must have a documented status code, and a JSON body must match its schema.
 * Violations are collected here and asserted empty after each test (test/setup.ts), so a wrong
 * schema fails the test that exercised it rather than turning the response into a 500.
 */
const violations: string[] = [];

export function takeViolations(): string[] {
  return violations.splice(0);
}

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const validators = new WeakMap<object, ValidateFunction>();

type Operation = OpenAPIV3_1.OperationObject;
type Response = OpenAPIV3_1.ResponseObject;

const openApiPath = (route: string) => route.replace(/:([A-Za-z]+)/g, '{$1}');

function documented(responses: Operation['responses'], status: number): Response | undefined {
  const codes = responses ?? {};
  return (codes[String(status)] ?? codes[`${String(status)[0]}XX`] ?? codes.default) as
    Response | undefined;
}

export function installConformance(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const route = req.routeOptions.url;
    // Only routes with documented responses; undocumented ones are listed in openapi.test.ts.
    if (!route || !req.routeOptions.schema?.response) return payload;
    const doc = app.swagger() as OpenAPIV3_1.Document;
    const op = doc.paths?.[openApiPath(route)]?.[req.method.toLowerCase() as 'get'];
    if (!op) return payload;
    const where = `${req.method} ${route} -> ${reply.statusCode}`;
    const response = documented(op.responses, reply.statusCode);
    if (!response) {
      violations.push(`${where}: status not documented`);
      return payload;
    }
    const schema = response.content?.['application/json']?.schema;
    const type = String(reply.getHeader('content-type') ?? '');
    if (!schema || !type.includes('application/json') || typeof payload !== 'string') {
      return payload;
    }
    let validate = validators.get(schema);
    if (!validate) {
      validate = ajv.compile(schema);
      validators.set(schema, validate);
    }
    if (!validate(JSON.parse(payload))) {
      violations.push(`${where}: ${ajv.errorsText(validate.errors)}`);
    }
    return payload;
  });
}
