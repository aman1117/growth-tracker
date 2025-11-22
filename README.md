## TODOs

- [ ] Design authentication database schema for the `users` table.
- [ ] Create an `activities` table to store activities for each day, with:
  - Columns for each activity detail (name, type, duration, etc.)
  - A foreign key `user_id` referencing the `users` table
