<?php
$db = new SQLite3(__DIR__ . '/../research/corpus/laravel-io/database/database.sqlite');
$db->exec('PRAGMA foreign_keys = OFF;');

$tables = [
"CREATE TABLE IF NOT EXISTS \"users\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"email\" TEXT NOT NULL,\"github_id\" TEXT DEFAULT '',\"github_username\" TEXT DEFAULT '',\"twitter\" TEXT,\"website\" TEXT,\"name\" TEXT NOT NULL,\"username\" TEXT NOT NULL DEFAULT '',\"password\" TEXT NOT NULL DEFAULT '',\"type\" INTEGER NOT NULL DEFAULT 1,\"bio\" TEXT NOT NULL DEFAULT '',\"remember_token\" TEXT NOT NULL DEFAULT '',\"banned_at\" TEXT,\"banned_reason\" TEXT,\"email_verified_at\" TEXT,\"allowed_notifications\" TEXT,\"bluesky_username\" TEXT,\"has_identicon\" INTEGER DEFAULT 0,\"verified_author_at\" TEXT,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"articles\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"uuid\" TEXT NOT NULL DEFAULT '',\"author_id\" INTEGER NOT NULL,\"title\" TEXT NOT NULL,\"body\" TEXT NOT NULL,\"original_url\" TEXT,\"slug\" TEXT NOT NULL DEFAULT '',\"hero_image\" TEXT,\"hero_image_url\" TEXT,\"hero_image_attribution\" TEXT,\"is_pinned\" INTEGER NOT NULL DEFAULT 0,\"view_count\" INTEGER,\"tweet_id\" INTEGER,\"submitted_at\" TEXT,\"approved_at\" TEXT,\"shared_at\" TEXT,\"declined_at\" TEXT,\"sponsored\" INTEGER DEFAULT 0,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"tags\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"name\" TEXT NOT NULL,\"slug\" TEXT NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"taggables\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"taggable_id\" INTEGER NOT NULL,\"tag_id\" INTEGER NOT NULL,\"taggable_type\" TEXT NOT NULL DEFAULT '',\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"threads\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"uuid\" TEXT NOT NULL DEFAULT '',\"author_id\" INTEGER NOT NULL,\"subject\" TEXT NOT NULL,\"body\" TEXT NOT NULL,\"slug\" TEXT NOT NULL DEFAULT '',\"last_activity_at\" TEXT,\"solution_reply_id\" INTEGER,\"resolved_by\" INTEGER,\"updated_by\" INTEGER,\"locked_at\" TEXT,\"locked_by\" INTEGER,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"replies\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"uuid\" TEXT NOT NULL DEFAULT '',\"body\" TEXT NOT NULL,\"author_id\" INTEGER NOT NULL,\"replyable_id\" INTEGER NOT NULL,\"replyable_type\" TEXT NOT NULL DEFAULT '',\"updated_by\" INTEGER,\"deleted_at\" TEXT,\"deleted_by\" INTEGER,\"deleted_reason\" TEXT,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"notifications\" (\"id\" TEXT PRIMARY KEY,\"type\" TEXT NOT NULL,\"notifiable_type\" TEXT NOT NULL,\"notifiable_id\" INTEGER NOT NULL,\"data\" TEXT NOT NULL,\"read_at\" TEXT,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"subscriptions\" (\"uuid\" TEXT PRIMARY KEY,\"user_id\" INTEGER NOT NULL,\"subscriptionable_id\" INTEGER NOT NULL,\"subscriptionable_type\" TEXT NOT NULL DEFAULT '',\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"likes\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"user_id\" INTEGER NOT NULL,\"likeable_id\" INTEGER NOT NULL,\"likeable_type\" TEXT NOT NULL,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"blocked_users\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"user_id\" INTEGER NOT NULL,\"blocked_user_id\" INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"spam_reports\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"reporter_id\" INTEGER NOT NULL,\"spam_type\" TEXT,\"spam_id\" INTEGER,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"sessions\" (\"id\" TEXT PRIMARY KEY,\"user_id\" INTEGER,\"ip_address\" TEXT,\"user_agent\" TEXT,\"payload\" TEXT NOT NULL,\"last_activity\" INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"personal_access_tokens\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"tokenable_type\" TEXT NOT NULL,\"tokenable_id\" INTEGER NOT NULL,\"name\" TEXT NOT NULL,\"token\" TEXT NOT NULL,\"abilities\" TEXT,\"last_used_at\" TEXT,\"expires_at\" TEXT,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"failed_jobs\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"uuid\" TEXT,\"connection\" TEXT NOT NULL,\"queue\" TEXT NOT NULL,\"payload\" TEXT NOT NULL,\"exception\" TEXT NOT NULL,\"failed_at\" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE TABLE IF NOT EXISTS \"jobs\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"queue\" TEXT NOT NULL,\"payload\" TEXT NOT NULL,\"attempts\" INTEGER NOT NULL,\"reserved_at\" INTEGER,\"available_at\" INTEGER NOT NULL,\"created_at\" INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"job_batches\" (\"id\" TEXT PRIMARY KEY,\"name\" TEXT NOT NULL,\"total_jobs\" INTEGER NOT NULL,\"pending_jobs\" INTEGER NOT NULL,\"failed_jobs\" INTEGER NOT NULL,\"failed_job_ids\" TEXT NOT NULL,\"options\" TEXT,\"cancelled_at\" INTEGER,\"created_at\" INTEGER NOT NULL,\"finished_at\" INTEGER)",
"CREATE TABLE IF NOT EXISTS \"password_resets\" (\"email\" TEXT NOT NULL,\"token\" TEXT NOT NULL,\"created_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"cache\" (\"key\" TEXT PRIMARY KEY,\"value\" TEXT NOT NULL,\"expiration\" INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"cache_locks\" (\"key\" TEXT PRIMARY KEY,\"owner\" TEXT NOT NULL,\"expiration\" INTEGER NOT NULL)",
"CREATE TABLE IF NOT EXISTS \"monitored_scheduled_tasks\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"name\" TEXT NOT NULL,\"type\" TEXT,\"cron_expression\" TEXT NOT NULL,\"timezone\" TEXT,\"ping_url\" TEXT,\"last_started_at\" TEXT,\"last_finished_at\" TEXT,\"last_failed_at\" TEXT,\"last_skipped_at\" TEXT,\"registered_on_oh_dear_at\" TEXT,\"last_pinged_at\" TEXT,\"grace_time_in_minutes\" INTEGER NOT NULL,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"monitored_scheduled_task_log_items\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"monitored_scheduled_task_id\" INTEGER NOT NULL,\"type\" TEXT NOT NULL,\"meta\" TEXT,\"created_at\" TEXT,\"updated_at\" TEXT)",
"CREATE TABLE IF NOT EXISTS \"migrations\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\"migration\" TEXT NOT NULL,\"batch\" INTEGER NOT NULL)",
];

foreach ($tables as $sql) {
    if (!$db->exec($sql)) {
        echo "ERR: " . $db->lastErrorMsg() . " | " . substr($sql, 0, 60) . "\n";
    }
}

$migrations = [
    '2013_09_17_113019_create_users_table',
    '2013_09_22_163103_create_articles_table',
    '2013_09_22_163347_create_tags_table',
    '2014_01_27_135001_forum_threads_create_table',
    '2014_01_27_141317_forum_replies_create_table',
    '2019_12_14_000001_create_personal_access_tokens_table',
    '2020_01_09_193921_create_notifications_table',
    '2020_04_07_181731_create_series_table',
    '2020_04_07_185543_create_community_articles_table',
    '2020_07_16_185353_add_twitter_columns',
    '2020_10_01_093001_add_email_verified_at_column_to_users',
    '2020_11_03_205735_add_uuid_to_failed_jobs_table',
    '2020_11_22_194212_create_schedule_monitor_tables',
    '2021_03_10_161050_add_index_to_replyable_type',
    '2021_07_05_205125_remove_series',
    '2021_07_23_110409_update_articles_table_add_hero_image_field',
    '2021_07_31_183222_unique_github_ids',
    '2021_09_12_220452_add_resolved_by_to_threads_table',
    '2021_10_31_143501_add_declined_at_column_to_articles_table',
    '2021_11_15_213258_add_updated_by_to_threads_and_replies_table',
    '2021_11_22_093555_migrate_thread_feed_to_timestamp',
    '2021_10_12_170118_add_locked_by_column_to_threads_table',
    '2022_04_06_152416_add_uuids_to_tables',
    '2022_05_10_180922_make_uuids_non_nullable',
    '2022_06_14_072001_create_blocked_users_table',
    '2022_07_09_191433_update_articles_table_add_view_count',
    '2022_07_29_135113_add__website_to_users_table',
    '2022_08_21_215918_add_soft_delete_columns_to_replies_table',
    '2022_07_08_145847_create_spam_reports_table',
    '2022_10_15_150405_add_banned_reason_to_users_table',
    '2022_12_11_145605_add_expires_at_column_sanctum',
    '2023_01_31_190506_add_allowed_notifications_column_to_users_table',
    '2024_08_28_104736_create_job_batches_table',
    '2024_08_28_104755_create_jobs_table',
    '2024_09_27_095949_add_hero_image_additional_columns_to_articles',
    '2024_11_28_202608_add_bluesky_column_to_users',
    '2025_03_28_104443_add_sponsored_column_to_articles_table',
    '2025_06_14_222049_add_verified_author_at_to_users_table',
    '2025_09_11_152525_add_has_identicon_to_users_table',
    '2025_09_12_073227_add_new_indexes',
    '2025_11_05_195225_create_cache_table',
];

$stmt = $db->prepare("INSERT OR IGNORE INTO migrations (migration, batch) VALUES (:m, 1)");
foreach ($migrations as $m) {
    $stmt->bindValue(':m', $m);
    $stmt->execute();
}

$r = $db->query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
$tables = [];
while ($row = $r->fetchArray(SQLITE3_ASSOC)) $tables[] = $row['name'];
echo "Tables created: " . implode(', ', $tables) . "\n";

$mc = $db->querySingle("SELECT COUNT(*) FROM migrations");
echo "Migrations marked: $mc\n";
echo "Done.\n";
