import {sqliteTable,text,integer,primaryKey,index,uniqueIndex} from 'drizzle-orm/sqlite-core';
export const practiceJournal=sqliteTable('practice_journal',{
 userId:text('user_id').notNull(),
 id:text('id').notNull(),
 record:text('record').notNull(),
 createdAt:text('created_at').notNull(),
 updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]}),index('idx_practice_journal_user_created').on(table.userId,table.createdAt)]);
export const learnerProfiles=sqliteTable('learner_profiles',{
 id:text('id').primaryKey(), userId:text('user_id'), email:text('email').notNull(),
 name:text('name').notNull(), assignedTrack:text('assigned_track'), activeTrack:text('active_track'),
 onboarded:text('onboarded').notNull().default('no'), createdAt:text('created_at').notNull(), updatedAt:text('updated_at').notNull(),
},table=>[uniqueIndex('idx_learner_profiles_user').on(table.userId),uniqueIndex('idx_learner_profiles_email').on(table.email)]);
export const courseProgress=sqliteTable('course_progress',{
 userId:text('user_id').notNull(), track:text('track').notNull(), state:text('state').notNull(), updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.track]})]);
export const academyJournal=sqliteTable('academy_journal',{
 userId:text('user_id').notNull(),track:text('track').notNull(),id:text('id').notNull(),record:text('record').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.track,table.id]}),index('idx_academy_journal_user_track_created').on(table.userId,table.track,table.createdAt)]);
// The Candle sign-in: one active code per email, hashed session tokens, and rate-limit events.
export const loginCodes=sqliteTable('login_codes',{
 email:text('email').primaryKey(), codeHash:text('code_hash').notNull(), expiresAt:integer('expires_at').notNull(),
 attempts:integer('attempts').notNull().default(0), createdAt:integer('created_at').notNull(),
});
export const sessions=sqliteTable('sessions',{
 tokenHash:text('token_hash').primaryKey(), userId:text('user_id').notNull(), email:text('email').notNull(),
 createdAt:integer('created_at').notNull(), expiresAt:integer('expires_at').notNull(),
},table=>[index('idx_sessions_email').on(table.email),index('idx_sessions_expires').on(table.expiresAt)]);
export const authEvents=sqliteTable('auth_events',{
 id:integer('id').primaryKey({autoIncrement:true}), key:text('key').notNull(), at:integer('at').notNull(),
},table=>[index('idx_auth_events_key_at').on(table.key,table.at)]);

// Shared school evidence. A nullable passed value means an ungraded reflection, not a failure.
export const learningEvents=sqliteTable('learning_events',{
 userId:text('user_id').notNull(),id:text('id').notNull(),exerciseId:text('exercise_id').notNull(),track:text('track').notNull(),lessonId:text('lesson_id').notNull(),source:text('source').notNull(),kind:text('kind').notNull(),passed:integer('passed'),input:text('input').notNull(),playbookId:text('playbook_id'),playbookVersion:integer('playbook_version'),day:text('day').notNull(),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.userId,t.id]}),index('idx_learning_events_user_day').on(t.userId,t.day)]);
export const learningTime=sqliteTable('learning_time',{userId:text('user_id').notNull(),day:text('day').notNull(),seconds:integer('seconds').notNull().default(0)},t=>[primaryKey({columns:[t.userId,t.day]})]);
export const learningClock=sqliteTable('learning_clock',{userId:text('user_id').primaryKey().notNull(),sessionId:text('session_id').notNull(),lastTick:integer('last_tick').notNull(),expiresAt:integer('expires_at').notNull()});
export const learningPreferences=sqliteTable('learning_preferences',{userId:text('user_id').primaryKey().notNull(),shared:integer('shared').notNull().default(0),alias:text('alias').notNull().default('')});

export const learningVisits=sqliteTable('learning_visits',{userId:text('user_id').notNull(),day:text('day').notNull()},t=>[primaryKey({columns:[t.userId,t.day]})]);
export const chartStudy=sqliteTable('chart_study',{userId:text('user_id').notNull(),id:text('id').notNull(),track:text('track').notNull(),symbol:text('symbol').notNull(),topic:text('topic').notNull(),minutes:integer('minutes').notNull(),note:text('note').notNull(),createdAt:text('created_at').notNull()},t=>[primaryKey({columns:[t.userId,t.id]})]);

// Paid membership (Stripe). A learner profile with no membership row is an invited/free learner.
// A row exists only for Stripe-managed members; access follows Stripe's subscription status.
export const memberships=sqliteTable('memberships',{
 email:text('email').primaryKey().notNull(), plan:text('plan').notNull(), status:text('status').notNull(),
 stripeCustomerId:text('stripe_customer_id'), stripeSubscriptionId:text('stripe_subscription_id'),
 currentPeriodEnd:integer('current_period_end'), cancelAtPeriodEnd:integer('cancel_at_period_end').notNull().default(0),
 createdAt:integer('created_at').notNull(), updatedAt:integer('updated_at').notNull(),
},t=>[index('idx_memberships_customer').on(t.stripeCustomerId),index('idx_memberships_subscription').on(t.stripeSubscriptionId)]);
// Stripe webhook events already handled, so a redelivered event is a no-op.
export const billingEvents=sqliteTable('billing_events',{
 id:text('id').primaryKey().notNull(), type:text('type').notNull(), at:integer('at').notNull(),
});
