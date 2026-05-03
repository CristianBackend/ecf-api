import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

const errorBody = (code: number, type: string, message: string) => ({
  schema: {
    example: {
      success: false,
      error: { code, type, message, timestamp: '2026-05-03T12:00:00.000Z', path: '/api/v1/...' },
    },
  },
});

/** 400 + 401 + 403 + 500 — presente en todos los endpoints protegidos con body. */
export function ApiStandardErrors() {
  return applyDecorators(
    ApiResponse({ status: 400, description: 'Datos de entrada inválidos (validación fallida)', ...errorBody(400, 'Bad Request', 'Validation failed: field is required') }),
    ApiResponse({ status: 401, description: 'API key ausente o inválida', ...errorBody(401, 'Unauthorized', 'Invalid or missing API key') }),
    ApiResponse({ status: 403, description: 'Scope insuficiente para esta operación', ...errorBody(403, 'Forbidden', 'Insufficient scope: INVOICES_WRITE required') }),
    ApiResponse({ status: 500, description: 'Error interno del servidor', ...errorBody(500, 'Internal Server Error', 'Internal server error') }),
  );
}

/** 401 + 403 + 500 — para endpoints sin body (GET, DELETE). */
export function ApiReadErrors() {
  return applyDecorators(
    ApiResponse({ status: 401, description: 'API key ausente o inválida', ...errorBody(401, 'Unauthorized', 'Invalid or missing API key') }),
    ApiResponse({ status: 403, description: 'Scope insuficiente para esta operación', ...errorBody(403, 'Forbidden', 'Insufficient scope') }),
    ApiResponse({ status: 500, description: 'Error interno del servidor', ...errorBody(500, 'Internal Server Error', 'Internal server error') }),
  );
}

/** 404 individual — usar junto con ApiStandardErrors o ApiReadErrors. */
export function ApiNotFoundError(resource = 'Recurso') {
  return ApiResponse({
    status: 404,
    description: `${resource} no encontrado`,
    ...errorBody(404, 'Not Found', `${resource} not found or does not belong to this tenant`),
  });
}

/** 409 para conflictos (duplicados, estado incorrecto). */
export function ApiConflictError(description = 'Conflicto de estado o duplicado') {
  return ApiResponse({
    status: 409,
    description,
    ...errorBody(409, 'Conflict', description),
  });
}
