package com.gitview.app.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

/**
 * Saved bridge connections. Metadata (name, URL, per-bridge provider, last-used time) lives in Room;
 * the bearer TOKEN lives in EncryptedSharedPreferences, backed by the Android Keystore — tokens never
 * sit in Room or plain prefs. See docs/SECURITY.md.
 */
@Entity(tableName = "connections")
data class Connection(
    @PrimaryKey val id: String, // stable id, e.g. UUID
    val name: String,
    val baseUrl: String,
    val lastRepo: String? = null,
    val provider: SessionProvider = SessionProvider.LOCAL_SDK, // per-bridge (redesign)
    val lastUsedAt: Long? = null, // epoch millis of last selection
)

class Converters {
    @TypeConverter
    fun toProvider(s: String): SessionProvider = runCatching { SessionProvider.valueOf(s) }.getOrDefault(SessionProvider.LOCAL_SDK)

    @TypeConverter
    fun fromProvider(p: SessionProvider): String = p.name
}

@Dao
interface ConnectionDao {
    @Query("SELECT * FROM connections ORDER BY name") fun observeAll(): Flow<List<Connection>>
    @Query("SELECT * FROM connections WHERE id = :id") suspend fun byId(id: String): Connection?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(c: Connection)
    @Query("DELETE FROM connections WHERE id = :id") suspend fun delete(id: String)
    @Query("UPDATE connections SET lastUsedAt = :t WHERE id = :id") suspend fun touch(id: String, t: Long)
    @Query("UPDATE connections SET provider = :p WHERE id = :id") suspend fun setProvider(id: String, p: SessionProvider)
}

/** v1→v2: add the per-bridge provider + last-used columns without wiping saved bridges. */
private val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'LOCAL_SDK'")
        db.execSQL("ALTER TABLE connections ADD COLUMN lastUsedAt INTEGER")
    }
}

@Database(entities = [Connection::class], version = 2, exportSchema = false)
@TypeConverters(Converters::class)
abstract class GitViewDb : RoomDatabase() {
    abstract fun connections(): ConnectionDao
}

/** Keystore-backed token storage, keyed by connection id. */
class TokenStore(context: Context) {
    private val prefs = run {
        val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "gitview_tokens", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }
    fun get(connectionId: String): String? = prefs.getString(connectionId, null)
    fun put(connectionId: String, token: String) = prefs.edit().putString(connectionId, token).apply()
    fun clear(connectionId: String) = prefs.edit().remove(connectionId).apply()
}

/** Single facade the ViewModel uses for connection persistence. */
class ConnectionStore(context: Context) {
    private val db = Room.databaseBuilder(context.applicationContext, GitViewDb::class.java, "gitview.db")
        .addMigrations(MIGRATION_1_2)
        .build()
    val dao: ConnectionDao = db.connections()
    val tokens = TokenStore(context.applicationContext)
}
