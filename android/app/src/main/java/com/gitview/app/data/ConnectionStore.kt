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
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.Flow

/**
 * Saved bridge connections. Metadata (name, URL) lives in Room; the bearer TOKEN lives in
 * EncryptedSharedPreferences, which is backed by the Android Keystore — tokens never sit in Room
 * or plain prefs. See docs/SECURITY.md.
 */
@Entity(tableName = "connections")
data class Connection(
    @PrimaryKey val id: String, // stable id, e.g. UUID
    val name: String,
    val baseUrl: String,
    val lastRepo: String? = null,
)

@Dao
interface ConnectionDao {
    @Query("SELECT * FROM connections ORDER BY name") fun observeAll(): Flow<List<Connection>>
    @Query("SELECT * FROM connections WHERE id = :id") suspend fun byId(id: String): Connection?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(c: Connection)
    @Query("DELETE FROM connections WHERE id = :id") suspend fun delete(id: String)
}

@Database(entities = [Connection::class], version = 1, exportSchema = false)
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
    private val db = Room.databaseBuilder(context.applicationContext, GitViewDb::class.java, "gitview.db").build()
    val dao: ConnectionDao = db.connections()
    val tokens = TokenStore(context.applicationContext)
}
