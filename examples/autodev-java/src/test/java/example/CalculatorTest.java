package example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CalculatorTest {
    @Test
    void addsTwoIntegers() {
        assertEquals(5, Calculator.add(2, 3));
    }
}
