-- User classes: administrators (as before), designers (the old `user`: Workbench, Document types)
-- and operators (Home, Jobs with review, Results only; the API's allow-list is `operatorMayCall`
-- in packages/shared/src/roles.ts). The worker never reads users.
ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = 'designer' WHERE role = 'user';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'designer', 'operator'));
