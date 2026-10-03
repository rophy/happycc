import * as React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { config } from '@/config';
import { DEFAULT_BRAND } from '@/text/brand';

/**
 * The product wordmark: the configured brand logo (`brand.logo`, a data URI
 * from the app config) or, without one, the brand name as text.
 */
export function BrandLogotype() {
    if (config.brand?.logo) {
        return <Image source={{ uri: config.brand.logo }} resizeMode="contain" style={styles.box} />;
    }
    return (
        <View style={[styles.box, styles.center]}>
            <Text style={styles.text} numberOfLines={1} adjustsFontSizeToFit>
                {config.brand?.name ?? DEFAULT_BRAND.name}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    box: {
        width: 300,
        height: 90,
    },
    center: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        ...Typography.logo(),
        fontSize: 48,
        color: theme.colors.text,
    },
}));
