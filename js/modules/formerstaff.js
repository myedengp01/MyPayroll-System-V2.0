// People › Former staff: the employee list opened on the Former staff tab
import { render as renderEmployees } from './employees.js';

export function render(el, ctx, params, query) {
  return renderEmployees(el, ctx, params, { ...query, status: query.status || 'former' });
}
