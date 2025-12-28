package com.growthtracker.app.di

import com.growthtracker.app.data.repository.ActivityRepositoryImpl
import com.growthtracker.app.data.repository.AuthRepositoryImpl
import com.growthtracker.app.data.repository.StreakRepositoryImpl
import com.growthtracker.app.data.repository.UserRepositoryImpl
import com.growthtracker.app.domain.repository.ActivityRepository
import com.growthtracker.app.domain.repository.AuthRepository
import com.growthtracker.app.domain.repository.StreakRepository
import com.growthtracker.app.domain.repository.UserRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {

    @Binds
    @Singleton
    abstract fun bindAuthRepository(impl: AuthRepositoryImpl): AuthRepository

    @Binds
    @Singleton
    abstract fun bindActivityRepository(impl: ActivityRepositoryImpl): ActivityRepository

    @Binds
    @Singleton
    abstract fun bindStreakRepository(impl: StreakRepositoryImpl): StreakRepository

    @Binds
    @Singleton
    abstract fun bindUserRepository(impl: UserRepositoryImpl): UserRepository
}
